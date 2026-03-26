import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DriverStatus, ShipmentStatus } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { UpdateDriverDto } from './dto/update-driver.dto';

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
        user: true,
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
          driverCode: input.driverCode,
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

  async getAssignedShipments(driverId: string, organizationId: string) {
    await this.ensureDriverExists(driverId, organizationId);

    const shipments = await this.prisma.shipment.findMany({
      where: {
        organizationId,
        currentDriverId: driverId,
        status: {
          in: [
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
        currentVehicle: true,
        stops: {
          orderBy: { stopSequence: 'asc' },
        },
        items: true,
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
