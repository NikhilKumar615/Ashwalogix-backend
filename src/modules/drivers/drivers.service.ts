import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  DriverStatus,
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
import { UpdateDriverDto } from './dto/update-driver.dto';

type Coordinate = {
  latitude: number;
  longitude: number;
};

const geocodeCache = new Map<string, Coordinate | null>();

@Injectable()
export class DriversService {
  constructor(private readonly prisma: PrismaService) {}

  async listDrivers(organizationId: string, status?: DriverStatus) {
    await this.normalizeDriverCodes(organizationId);

    return this.prisma.driver.findMany({
      where: {
        organizationId,
        ...(status ? { status } : {}),
      },
      include: {
        user: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getDriverById(driverId: string, organizationId: string) {
    await this.normalizeDriverCodes(organizationId);

    const driver = await this.prisma.driver.findFirst({
      where: {
        id: driverId,
        organizationId,
      },
      include: {
        user: true,
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
          user: true,
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

    return {
      driverId,
      userId: driver.userId,
      temporaryPassword,
    };
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
        proofOfDeliveries: {
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
        currentVehicle: true,
        assignments: {
          where: { driverId },
          orderBy: { assignedAt: 'desc' },
        },
        proofOfDeliveries: {
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

    if (geocodeCache.has(normalizedAddress)) {
      return geocodeCache.get(normalizedAddress) ?? null;
    }

    try {
      const googleApiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
      const coordinate = googleApiKey
        ? await this.geocodeWithGoogle(normalizedAddress, googleApiKey)
        : await this.geocodeWithNominatim(normalizedAddress);

      geocodeCache.set(normalizedAddress, coordinate);
      return coordinate;
    } catch {
      geocodeCache.set(normalizedAddress, null);
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
