import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, VehicleOwnerType, VehicleStatus } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  async listVehicles(organizationId: string, status?: VehicleStatus) {
    return this.prisma.vehicle.findMany({
      where: {
        organizationId,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        assignments: {
          orderBy: { assignedAt: 'desc' },
          take: 5,
        },
        currentShipments: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    });
  }

  async createVehicle(organizationId: string, input: CreateVehicleDto) {
    return this.prisma.vehicle.create({
      data: {
        organizationId,
        vehicleNumber: input.vehicleNumber.toUpperCase(),
        vehicleType: input.vehicleType,
        capacityWeight:
          input.capacityWeight !== undefined
            ? new Prisma.Decimal(input.capacityWeight)
            : undefined,
        capacityVolume:
          input.capacityVolume !== undefined
            ? new Prisma.Decimal(input.capacityVolume)
            : undefined,
        ownerType: input.ownerType ?? VehicleOwnerType.OWNED,
        status: input.status ?? VehicleStatus.ACTIVE,
        notes: input.notes,
      },
    });
  }

  async getVehicleById(organizationId: string, vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: {
        id: vehicleId,
        organizationId,
      },
      include: {
        assignments: {
          include: {
            shipment: true,
            driver: true,
          },
          orderBy: { assignedAt: 'desc' },
          take: 10,
        },
        currentShipments: {
          include: {
            companyClient: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }

    return {
      ...vehicle,
      currentShipments: vehicle.currentShipments.map((shipment) =>
        this.mapShipmentCompanyClient(shipment),
      ),
    };
  }

  async updateVehicle(
    organizationId: string,
    vehicleId: string,
    input: UpdateVehicleDto,
  ) {
    await this.ensureVehicleExists(organizationId, vehicleId);

    return this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: {
        vehicleNumber: input.vehicleNumber?.toUpperCase(),
        vehicleType: input.vehicleType,
        capacityWeight:
          input.capacityWeight !== undefined
            ? new Prisma.Decimal(input.capacityWeight)
            : undefined,
        capacityVolume:
          input.capacityVolume !== undefined
            ? new Prisma.Decimal(input.capacityVolume)
            : undefined,
        ownerType: input.ownerType,
        status: input.status,
        notes: input.notes,
      },
    });
  }

  private async ensureVehicleExists(organizationId: string, vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: {
        id: vehicleId,
        organizationId,
      },
    });

    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }

    return vehicle;
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
