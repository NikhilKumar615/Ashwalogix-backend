import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  VehicleCapacityWeightUnit,
  VehicleOwnerType,
  VehicleStatus,
} from '@prisma/client';
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
    return this.prisma.$transaction(async (tx) => {
      const vehicleCode = await this.generateVehicleCode(tx, organizationId);

      return tx.vehicle.create({
        data: {
          organizationId,
          vehicleCode,
          vehicleNumber: input.vehicleNumber.toUpperCase(),
          vehicleType: input.vehicleType,
          capacityWeight:
            input.capacityWeight !== undefined
              ? new Prisma.Decimal(input.capacityWeight)
              : undefined,
          capacityWeightUnit: input.capacityWeightUnit ?? VehicleCapacityWeightUnit.KG,
          ownerType: input.ownerType ?? VehicleOwnerType.OWNED,
          status: input.status ?? VehicleStatus.ACTIVE,
          notes: input.notes,
        },
      });
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
        capacityWeightUnit: input.capacityWeightUnit,
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

  private async generateVehicleCode(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ) {
    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });

    const orgToken = this.buildCodeToken(organization?.name || 'ORG', 3);
    const prefix = `${orgToken}-VEH-`;

    const existingCodes = await tx.vehicle.findMany({
      where: {
        organizationId,
        vehicleCode: {
          startsWith: prefix,
        },
      },
      select: { vehicleCode: true },
    });

    const nextSequence =
      existingCodes.reduce((highest, vehicle) => {
        const match = vehicle.vehicleCode?.match(/-(\d{3,})$/);
        const numericPart = match ? Number(match[1]) : 0;
        return numericPart > highest ? numericPart : highest;
      }, 0) + 1;

    return `${prefix}${String(nextSequence).padStart(3, '0')}`;
  }

  private buildCodeToken(value: string, length: number) {
    const normalized = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const base = normalized || 'X'.repeat(length);
    return base.slice(0, length).padEnd(length, 'X');
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
