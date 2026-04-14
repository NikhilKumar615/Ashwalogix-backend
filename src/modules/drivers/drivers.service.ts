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

    return shipments.map((shipment) => this.mapShipmentCompanyClient(shipment));
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

    return shipments.map((shipment) => this.mapShipmentCompanyClient(shipment));
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
