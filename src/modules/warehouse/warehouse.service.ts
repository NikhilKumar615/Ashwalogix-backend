import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  InventoryItemStatus,
  InventoryMovementType,
  Prisma,
  WarehouseStatus,
} from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  buildBusinessPrefix,
  formatNumericCode,
  parseNumericCodeSequence,
} from '../../shared/codes/entity-code.util';
import { CreateInventoryItemDto } from './dto/create-inventory-item.dto';
import { CreateInventoryMovementDto } from './dto/create-inventory-movement.dto';
import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { UpdateInventoryItemDto } from './dto/update-inventory-item.dto';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto';

@Injectable()
export class WarehouseService {
  constructor(private readonly prisma: PrismaService) {}

  async listWarehouses(organizationId: string, status?: WarehouseStatus) {
    return this.prisma.warehouse.findMany({
      where: {
        organizationId,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createWarehouse(organizationId: string, input: CreateWarehouseDto) {
    const warehouseCode = await this.generateWarehouseCode(organizationId);

    return this.prisma.warehouse.create({
      data: {
        organizationId,
        warehouseCode,
        name: input.name,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        country: input.country ?? 'India',
        status: input.status ?? WarehouseStatus.ACTIVE,
        notes: input.notes,
      },
    });
  }

  private async generateWarehouseCode(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const prefix = buildBusinessPrefix(organization.name);
    const existingCodes = await this.prisma.warehouse.findMany({
      where: { organizationId },
      select: { warehouseCode: true },
    });
    const nextSequence =
      existingCodes.reduce((highest, warehouse) => {
        const sequence = parseNumericCodeSequence(
          warehouse.warehouseCode,
          prefix,
          'WAR',
        );
        return sequence !== null && sequence > highest ? sequence : highest;
      }, 0) + 1;

    return formatNumericCode(prefix, 'WAR', nextSequence);
  }

  async getWarehouseById(organizationId: string, warehouseId: string) {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: {
        id: warehouseId,
        organizationId,
      },
    });

    if (!warehouse) {
      throw new NotFoundException('Warehouse not found');
    }

    return warehouse;
  }

  async updateWarehouse(
    organizationId: string,
    warehouseId: string,
    input: UpdateWarehouseDto,
  ) {
    await this.ensureWarehouseExists(organizationId, warehouseId);

    return this.prisma.warehouse.update({
      where: { id: warehouseId },
      data: {
        warehouseCode: input.warehouseCode,
        name: input.name,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        country: input.country,
        status: input.status,
        notes: input.notes,
      },
    });
  }

  async listInventoryItems(
    organizationId: string,
    status?: InventoryItemStatus,
  ) {
    return this.prisma.inventoryItem.findMany({
      where: {
        organizationId,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createInventoryItem(
    organizationId: string,
    input: CreateInventoryItemDto,
  ) {
    return this.prisma.inventoryItem.create({
      data: {
        organizationId,
        itemCode: input.itemCode,
        name: input.name,
        description: input.description,
        category: input.category,
        unitOfMeasure: input.unitOfMeasure,
        minThreshold:
          input.minThreshold !== undefined
            ? new Prisma.Decimal(input.minThreshold)
            : undefined,
        maxThreshold:
          input.maxThreshold !== undefined
            ? new Prisma.Decimal(input.maxThreshold)
            : undefined,
        status: input.status ?? InventoryItemStatus.ACTIVE,
        notes: input.notes,
      },
    });
  }

  async getInventoryItemById(organizationId: string, inventoryItemId: string) {
    const inventoryItem = await this.prisma.inventoryItem.findFirst({
      where: {
        id: inventoryItemId,
        organizationId,
      },
    });

    if (!inventoryItem) {
      throw new NotFoundException('Inventory item not found');
    }

    return inventoryItem;
  }

  async updateInventoryItem(
    organizationId: string,
    inventoryItemId: string,
    input: UpdateInventoryItemDto,
  ) {
    await this.ensureInventoryItemExists(organizationId, inventoryItemId);

    return this.prisma.inventoryItem.update({
      where: { id: inventoryItemId },
      data: {
        itemCode: input.itemCode,
        name: input.name,
        description: input.description,
        category: input.category,
        unitOfMeasure: input.unitOfMeasure,
        minThreshold:
          input.minThreshold !== undefined
            ? new Prisma.Decimal(input.minThreshold)
            : undefined,
        maxThreshold:
          input.maxThreshold !== undefined
            ? new Prisma.Decimal(input.maxThreshold)
            : undefined,
        status: input.status,
        notes: input.notes,
      },
    });
  }

  async getWarehouseStock(organizationId: string, warehouseId: string) {
    await this.ensureWarehouseExists(organizationId, warehouseId);

    return this.prisma.inventoryStock.findMany({
      where: {
        organizationId,
        warehouseId,
      },
      include: {
        inventoryItem: true,
        warehouse: true,
      },
      orderBy: [
        { inventoryItem: { name: 'asc' } },
        { storageLocation: 'asc' },
      ],
    });
  }

  async listInventoryMovements(
    organizationId: string,
    warehouseId?: string,
    inventoryItemId?: string,
  ) {
    return this.prisma.inventoryMovement.findMany({
      where: {
        organizationId,
        ...(warehouseId ? { warehouseId } : {}),
        ...(inventoryItemId ? { inventoryItemId } : {}),
      },
      include: {
        warehouse: true,
        inventoryItem: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async createInventoryMovement(
    organizationId: string,
    input: CreateInventoryMovementDto,
  ) {
    await this.ensureWarehouseExists(organizationId, input.warehouseId);
    await this.ensureInventoryItemExists(organizationId, input.inventoryItemId);

    return this.prisma.$transaction(async (tx) => {
      const stock = await tx.inventoryStock.findFirst({
        where: {
          organizationId,
          warehouseId: input.warehouseId,
          inventoryItemId: input.inventoryItemId,
          storageLocation: input.storageLocation ?? null,
        },
      });

      const currentQuantity = stock
        ? Number(stock.quantityOnHand)
        : 0;

      const nextQuantity = this.calculateNextQuantity(
        currentQuantity,
        input.movementType,
        input.quantity,
      );

      if (nextQuantity < 0) {
        throw new BadRequestException(
          'Inventory movement would make stock negative',
        );
      }

      const movement = await tx.inventoryMovement.create({
        data: {
          organizationId,
          warehouseId: input.warehouseId,
          inventoryItemId: input.inventoryItemId,
          movementType: input.movementType,
          quantity: new Prisma.Decimal(input.quantity),
          storageLocation: input.storageLocation,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          notes: input.notes,
          performedBy: input.performedBy,
        },
        include: {
          warehouse: true,
          inventoryItem: true,
        },
      });

      if (stock) {
        await tx.inventoryStock.update({
          where: { id: stock.id },
          data: {
            quantityOnHand: new Prisma.Decimal(nextQuantity),
          },
        });
      } else {
        await tx.inventoryStock.create({
          data: {
            organizationId,
            warehouseId: input.warehouseId,
            inventoryItemId: input.inventoryItemId,
            storageLocation: input.storageLocation,
            quantityOnHand: new Prisma.Decimal(nextQuantity),
          },
        });
      }

      return movement;
    });
  }

  private calculateNextQuantity(
    currentQuantity: number,
    movementType: InventoryMovementType,
    quantity: number,
  ) {
    switch (movementType) {
      case InventoryMovementType.INBOUND:
        return currentQuantity + quantity;
      case InventoryMovementType.OUTBOUND:
        return currentQuantity - quantity;
      case InventoryMovementType.ADJUSTMENT:
        return currentQuantity + quantity;
      case InventoryMovementType.TRANSFER:
        return currentQuantity - quantity;
      default:
        return currentQuantity;
    }
  }

  private async ensureWarehouseExists(organizationId: string, warehouseId: string) {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: {
        id: warehouseId,
        organizationId,
      },
    });

    if (!warehouse) {
      throw new NotFoundException('Warehouse not found');
    }

    return warehouse;
  }

  private async ensureInventoryItemExists(
    organizationId: string,
    inventoryItemId: string,
  ) {
    const inventoryItem = await this.prisma.inventoryItem.findFirst({
      where: {
        id: inventoryItemId,
        organizationId,
      },
    });

    if (!inventoryItem) {
      throw new NotFoundException('Inventory item not found');
    }

    return inventoryItem;
  }
}
