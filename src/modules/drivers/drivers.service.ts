import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DriverStatus,
  OrganizationRole,
  ShipmentAssignmentStatus,
  ShipmentStatus,
} from '@prisma/client';
import { hash } from 'bcryptjs';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  buildBusinessPrefix,
  buildStatePrefix,
  formatRollingAlphaCodeWithState,
  parseRollingAlphaCodeSequence,
} from '../../shared/codes/entity-code.util';
import {
  SAFE_USER_SELECT,
  invalidateUserSession,
} from '../auth/auth-security.util';
import { UpdateDriverDto } from './dto/update-driver.dto';
import {
  BoundedTtlCache,
  GEOCODE_FETCH_TIMEOUT_MS,
} from '../shipments/geocoding.util';

type Coordinate = {
  latitude: number;
  longitude: number;
};

// Bounded LRU with TTL: hits cached for a day, misses for 5 minutes.
const geocodeCache = new BoundedTtlCache<Coordinate | null>();
const GEOCODE_ERROR_TTL_MS = 60 * 1000;

@Injectable()
export class DriversService {
  constructor(private readonly prisma: PrismaService) {}

  async listDrivers(organizationId: string, status?: DriverStatus) {
    return this.prisma.driver.findMany({
      where: {
        organizationId,
        ...(status ? { status } : {}),
      },
      include: {
        user: { select: SAFE_USER_SELECT },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getDriverById(driverId: string, organizationId: string) {
    const driver = await this.prisma.driver.findFirst({
      where: {
        id: driverId,
        organizationId,
      },
      include: {
        user: { select: SAFE_USER_SELECT },
        assignments: {
          include: {
            shipment: true,
            vehicle: true,
          },
          orderBy: { assignedAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!driver) {
      throw new NotFoundException('Driver not found');
    }

    return driver;
  }

  async updateDriver(
    driverId: string,
    organizationId: string,
    input: UpdateDriverDto,
  ) {
    const driver = await this.ensureDriverExists(driverId, organizationId);

    if (driver.userId && (input.email || input.phone || input.fullName)) {
      await this.assertLinkedUserIsOnlyADriver(driver.userId);
    }

    if (input.email || input.phone) {
      await this.ensureDriverIdentityIsAvailable(
        driverId,
        driver.userId,
        input.email,
        input.phone,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updatedDriver = await tx.driver.update({
        where: { id: driverId },
        data: {
          fullName: input.fullName,
          phone: input.phone,
          email: input.email?.toLowerCase(),
          employmentType: input.employmentType,
          status: input.status,
          licenseNumber: input.licenseNumber,
          licenseExpiry: input.licenseExpiry
            ? new Date(input.licenseExpiry)
            : undefined,
          homeBase: input.homeBase,
          notes: input.notes,
        },
        include: {
          user: { select: SAFE_USER_SELECT },
        },
      });

      if (driver.userId) {
        await tx.user.update({
          where: { id: driver.userId },
          data: {
            fullName: input.fullName,
            phone: input.phone,
            email: input.email?.toLowerCase(),
          },
        });
      }

      return updatedDriver;
    });
  }

  async regeneratePassword(
    driverId: string,
    organizationId: string,
    nextPassword?: string,
  ) {
    const driver = await this.ensureDriverExists(driverId, organizationId);

    if (!driver.userId) {
      throw new BadRequestException('This driver does not have a linked user account');
    }

    await this.assertLinkedUserIsOnlyADriver(driver.userId);

    const temporaryPassword = nextPassword || this.generateTemporaryPassword();
    const passwordHash = await hash(temporaryPassword, 10);

    await this.prisma.user.update({
      where: { id: driver.userId },
      data: {
        passwordHash,
        resetPasswordToken: null,
        resetPasswordTokenExpiresAt: null,
      },
    });
    invalidateUserSession(driver.userId);

    return {
      driverId,
      userId: driver.userId,
      temporaryPassword,
    };
  }

  async deleteDriver(driverId: string, organizationId: string, reason: string, deletedByUserId: string) {
    const driver = await this.ensureDriverExists(driverId, organizationId);
    const assignmentCount = await this.prisma.shipmentAssignment.count({ where: { driverId } });
    if (assignmentCount) {
      throw new BadRequestException('Drivers with assignment history cannot be deleted. Set their status to inactive instead.');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.deletionAudit.create({ data: { organizationId, entityType: 'DRIVER', entityId: driver.id, entityLabel: driver.fullName, reason: reason.trim(), deletedByUserId } });
      await tx.driver.delete({ where: { id: driverId } });
    });
    return { id: driverId, deleted: true };
  }

  async normalizeDriverCodes(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, state: true },
    });

    if (!organization) {
      return { updatedCount: 0 };
    }

    const drivers = await this.prisma.driver.findMany({
      where: { organizationId },
      select: { id: true, driverCode: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const prefix = buildBusinessPrefix(organization.name);
    const statePrefix = buildStatePrefix(organization.state);

    let nextSequence =
      drivers.reduce((highest, driver) => {
        const sequence = parseRollingAlphaCodeSequence(
          driver.driverCode,
          prefix,
          'DRV',
          statePrefix,
        );
        return sequence !== null && sequence > highest ? sequence : highest;
      }, -1) + 1;

    const legacyDrivers = drivers.filter((driver) => {
      return (
        !driver.driverCode ||
        parseRollingAlphaCodeSequence(
          driver.driverCode,
          prefix,
          'DRV',
          statePrefix,
        ) === null
      );
    });

    for (const legacyDriver of legacyDrivers) {
      await this.prisma.driver.update({
        where: { id: legacyDriver.id },
        data: {
          driverCode: formatRollingAlphaCodeWithState(
            prefix,
            'DRV',
            statePrefix,
            nextSequence,
          ),
        },
      });
      nextSequence += 1;
    }

    return { updatedCount: legacyDrivers.length };
  }

  async getAssignedShipments(driverId: string, organizationId: string) {
    await this.ensureDriverExists(driverId, organizationId);

    const shipments = await this.prisma.shipment.findMany({
      where: {
        organizationId,
        OR: [
          { currentDriverId: driverId },
          {
            assignments: {
              some: {
                driverId,
                assignmentStatus: ShipmentAssignmentStatus.ACTIVE,
              },
            },
          },
        ],
        status: {
          in: [
            ShipmentStatus.DRAFT,
            ShipmentStatus.PLANNED,
            ShipmentStatus.ASSIGNED,
            ShipmentStatus.EN_ROUTE_PICKUP,
            ShipmentStatus.AT_PICKUP,
            ShipmentStatus.PICKED_UP,
            ShipmentStatus.IN_TRANSIT,
            ShipmentStatus.AT_DELIVERY,
          ],
        },
      },
      orderBy: { plannedPickupAt: 'asc' },
      include: {
        companyClient: true,
        sourceLocation: true,
        destinationLocation: true,
        currentDriver: true,
        currentVehicle: true,
        stops: {
          orderBy: { stopSequence: 'asc' },
        },
        items: true,
        assignments: {
          where: {
            driverId,
          },
          include: {
            driver: true,
            vehicle: true,
          },
          orderBy: { assignedAt: 'desc' },
        },
        statusEvents: {
          include: {
            driver: true,
          },
          orderBy: { eventTime: 'desc' },
        },
        documents: {
          orderBy: { uploadedAt: 'desc' },
        },
        proofOfDeliveries: {
          include: {
            photoDocument: true,
            signatureDocument: true,
          },
          orderBy: { capturedAt: 'desc' },
        },
      },
    });

    return Promise.all(
      shipments.map((shipment) => this.enrichShipmentCoordinates(shipment)),
    );
  }

  async getShipmentHistory(driverId: string, organizationId: string) {
    await this.ensureDriverExists(driverId, organizationId);

    const shipments = await this.prisma.shipment.findMany({
      where: {
        organizationId,
        assignments: {
          some: {
            driverId,
          },
        },
        status: {
          in: [
            ShipmentStatus.DELIVERED,
            ShipmentStatus.COMPLETED,
            ShipmentStatus.FAILED,
            ShipmentStatus.CANCELLED,
          ],
        },
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        companyClient: true,
        sourceLocation: true,
        destinationLocation: true,
        currentDriver: true,
        currentVehicle: true,
        stops: {
          orderBy: { stopSequence: 'asc' },
        },
        items: true,
        assignments: {
          where: { driverId },
          include: {
            driver: true,
            vehicle: true,
          },
          orderBy: { assignedAt: 'desc' },
        },
        statusEvents: {
          include: {
            driver: true,
          },
          orderBy: { eventTime: 'desc' },
        },
        documents: {
          orderBy: { uploadedAt: 'desc' },
        },
        proofOfDeliveries: {
          include: {
            photoDocument: true,
            signatureDocument: true,
          },
          orderBy: { capturedAt: 'desc' },
        },
      },
    });

    return Promise.all(
      shipments.map((shipment) => this.enrichShipmentCoordinates(shipment)),
    );
  }

  private async ensureDriverExists(driverId: string, organizationId: string) {
    if (!driverId || !organizationId) {
      throw new BadRequestException('driverId and organizationId are required');
    }

    const driver = await this.prisma.driver.findFirst({
      where: {
        id: driverId,
        organizationId,
      },
    });

    if (!driver) {
      throw new BadRequestException(
        `Driver ${driverId} does not exist for organization ${organizationId}`,
      );
    }

    return driver;
  }

  private generateTemporaryPassword() {
    return `Lg${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  }

  /**
   * Driver management (OPERATIONS/drivers section) must not become a path to
   * take over a non-driver account (e.g. an ORG_ADMIN who also has a driver
   * profile) by resetting its password or changing its email.
   */
  private async assertLinkedUserIsOnlyADriver(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        platformRole: true,
        organizationMembers: { select: { organizationId: true, role: true } },
      },
    });

    const privileged =
      !!user?.platformRole ||
      user?.organizationMembers.some(
        (membership) => membership.role !== OrganizationRole.DRIVER,
      );

    if (privileged) {
      throw new ForbiddenException(
        'This driver is linked to a staff/admin account. Manage that account from Users instead.',
      );
    }

  }

  private async ensureDriverIdentityIsAvailable(
    driverId: string,
    userId: string | null,
    email?: string,
    phone?: string,
  ) {
    const conflictingDriver = await this.prisma.driver.findFirst({
      where: {
        id: {
          not: driverId,
        },
        OR: [
          ...(email ? [{ email: email.toLowerCase() }] : []),
          ...(phone ? [{ phone }] : []),
        ],
      },
    });

    if (conflictingDriver) {
      throw new BadRequestException(
        'Another driver already exists with this email or phone',
      );
    }

    if (!userId) {
      return;
    }

    const conflictingUser = await this.prisma.user.findFirst({
      where: {
        id: {
          not: userId,
        },
        OR: [
          ...(email ? [{ email: email.toLowerCase() }] : []),
          ...(phone ? [{ phone }] : []),
        ],
      },
    });

    if (conflictingUser) {
      throw new BadRequestException(
        'Another user already exists with this email or phone',
      );
    }
  }

  private mapShipmentCompanyClient<
    T extends { companyClient?: { companyClientCode?: string } | null },
  >(shipment: T) {
    const { companyClient, ...rest } = shipment;

    return {
      ...rest,
      companyClient: this.mapCompanyClient(companyClient),
    };
  }

  private async enrichShipmentCoordinates<
    T extends {
      adminFormData?: unknown;
      sourceLocation?: Record<string, unknown> | null;
      destinationLocation?: Record<string, unknown> | null;
      sourceAddressSnapshot?: unknown;
      destinationAddressSnapshot?: unknown;
      stops?: Array<Record<string, unknown>> | null;
      companyClient?: { companyClientCode?: string } | null;
    },
  >(shipment: T) {
    const mappedShipment = this.mapShipmentCompanyClient(shipment);
    const resolvedPickupCoordinates = await this.resolveShipmentCoordinate(
      shipment,
      'pickup',
    );
    const resolvedDestinationCoordinates = await this.resolveShipmentCoordinate(
      shipment,
      'destination',
    );

    return {
      ...mappedShipment,
      resolvedPickupCoordinates,
      resolvedDestinationCoordinates,
    };
  }

  private async resolveShipmentCoordinate(
    shipment: {
      adminFormData?: unknown;
      sourceLocation?: Record<string, unknown> | null;
      destinationLocation?: Record<string, unknown> | null;
      sourceAddressSnapshot?: unknown;
      destinationAddressSnapshot?: unknown;
      stops?: Array<Record<string, unknown>> | null;
    },
    kind: 'pickup' | 'destination',
  ) {
    const formData =
      shipment.adminFormData &&
      typeof shipment.adminFormData === 'object' &&
      !Array.isArray(shipment.adminFormData)
        ? (shipment.adminFormData as Record<string, unknown>)
        : {};
    const stopType = kind === 'pickup' ? 'PICKUP' : 'DELIVERY';
    const stop =
      shipment.stops?.find((candidate) => candidate.stopType === stopType) || null;
    const location =
      kind === 'pickup' ? shipment.sourceLocation : shipment.destinationLocation;
    const snapshotValue =
      kind === 'pickup'
        ? shipment.sourceAddressSnapshot
        : shipment.destinationAddressSnapshot;
    const snapshot =
      snapshotValue &&
      typeof snapshotValue === 'object' &&
      !Array.isArray(snapshotValue)
        ? (snapshotValue as Record<string, unknown>)
        : null;

    const directCoordinate = this.firstValidCoordinate(
      [
        formData[kind === 'pickup' ? 'originLatitude' : 'destinationLatitude'],
        formData[kind === 'pickup' ? 'originLongitude' : 'destinationLongitude'],
      ],
      [
        formData[kind === 'pickup' ? 'pickupLatitude' : 'receiverLatitude'],
        formData[kind === 'pickup' ? 'pickupLongitude' : 'receiverLongitude'],
      ],
      [snapshot?.latitude, snapshot?.longitude],
      [stop?.latitude, stop?.longitude],
      [location?.latitude, location?.longitude],
    );

    if (directCoordinate) {
      return directCoordinate;
    }

    const addressCandidates = this.buildAddressCandidates({
      formData,
      stop,
      location,
      snapshot,
      kind,
    });

    for (const candidate of addressCandidates) {
      const geocodedCoordinate = await this.geocodeAddress(candidate);
      if (geocodedCoordinate) {
        return geocodedCoordinate;
      }
    }

    return null;
  }

  private firstValidCoordinate(
    ...pairs: Array<[unknown, unknown] | null | undefined>
  ): Coordinate | null {
    for (const pair of pairs) {
      if (!pair) {
        continue;
      }

      const latitude = Number(pair[0]);
      const longitude = Number(pair[1]);

      if (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        !(latitude === 0 && longitude === 0)
      ) {
        return { latitude, longitude };
      }
    }

    return null;
  }

  private buildAddressCandidates(input: {
    formData: Record<string, unknown>;
    stop: Record<string, unknown> | null;
    location: Record<string, unknown> | null | undefined;
    snapshot: Record<string, unknown> | null | undefined;
    kind: 'pickup' | 'destination';
  }) {
    const rawCandidates = [
      [
        input.location?.name,
        input.location?.addressLine1,
        input.location?.addressLine2,
        input.location?.city,
        input.location?.state,
        input.location?.postalCode,
        input.location?.country,
      ],
      [
        input.stop?.locationName,
        input.stop?.addressLine1,
        input.stop?.addressLine2,
        input.stop?.city,
        input.stop?.state,
        input.stop?.postalCode,
        input.stop?.country,
      ],
      [
        input.snapshot?.name,
        input.snapshot?.addressLine1,
        input.snapshot?.addressLine2,
        input.snapshot?.city,
        input.snapshot?.state,
        input.snapshot?.postalCode,
        input.snapshot?.country,
      ],
      [
        input.formData[
          input.kind === 'pickup' ? 'originName' : 'destinationName'
        ],
        input.formData[
          input.kind === 'pickup' ? 'originAddress' : 'deliveryAddress'
        ],
        input.formData[
          input.kind === 'pickup' ? 'originCity' : 'destinationCity'
        ],
        input.formData[
          input.kind === 'pickup' ? 'originState' : 'destinationState'
        ],
        input.formData[
          input.kind === 'pickup' ? 'originPincode' : 'destinationPincode'
        ],
        input.formData[
          input.kind === 'pickup' ? 'originCountry' : 'destinationCountry'
        ],
      ],
    ];

    return [...new Set(
      rawCandidates
        .map((parts) =>
          parts
            .map((part) => String(part || '').trim())
            .filter(Boolean)
            .join(', '),
        )
        .filter(Boolean)
        .map((candidate) =>
          /\bindia\b/i.test(candidate) ? candidate : `${candidate}, India`,
        ),
    )];
  }

  private async geocodeAddress(address: string): Promise<Coordinate | null> {
    const normalizedAddress = address.trim();
    if (!normalizedAddress) {
      return null;
    }

    const cached = geocodeCache.lookup(normalizedAddress);
    if (cached) {
      return cached.value;
    }

    try {
      const googleApiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
      const coordinate = googleApiKey
        ? await this.geocodeWithGoogle(normalizedAddress, googleApiKey)
        : await this.geocodeWithNominatim(normalizedAddress);

      geocodeCache.setResult(normalizedAddress, coordinate);
      return coordinate;
    } catch {
      geocodeCache.set(normalizedAddress, null, GEOCODE_ERROR_TTL_MS);
      return null;
    }
  }

  private async geocodeWithGoogle(
    address: string,
    apiKey: string,
  ): Promise<Coordinate | null> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', address);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('region', 'in');

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(GEOCODE_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      results?: Array<{
        geometry?: { location?: { lat?: number; lng?: number } };
      }>;
      status?: string;
    };

    if (payload.status !== 'OK') {
      return null;
    }

    const latitude = Number(payload.results?.[0]?.geometry?.location?.lat);
    const longitude = Number(payload.results?.[0]?.geometry?.location?.lng);

    return this.firstValidCoordinate([latitude, longitude]);
  }

  private async geocodeWithNominatim(address: string): Promise<Coordinate | null> {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    url.searchParams.set('countrycodes', 'in');
    url.searchParams.set('q', address);

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'AshwaLogix/1.0 shipment-coordinate-resolver',
      },
      signal: AbortSignal.timeout(GEOCODE_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as Array<{
      lat?: string;
      lon?: string;
    }>;

    const latitude = Number(payload?.[0]?.lat);
    const longitude = Number(payload?.[0]?.lon);

    return this.firstValidCoordinate([latitude, longitude]);
  }

  private mapCompanyClient<
    T extends { companyClientCode?: string } | null | undefined,
  >(
    companyClient: T,
  ) {
    if (!companyClient) {
      return null;
    }

    const { companyClientCode, ...rest } = companyClient;

    return {
      ...rest,
      companyClientCode: companyClientCode ?? null,
    };
  }
}
