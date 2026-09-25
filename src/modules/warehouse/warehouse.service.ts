import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryItemStatus,
  InventoryMovementType,
  Prisma,
  StorageLocationStatus,
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
import { CreateStorageLocationDto } from './dto/create-storage-location.dto';
import { ReverseInventoryMovementDto } from './dto/reverse-inventory-movement.dto';
import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { UpdateInventoryItemDto } from './dto/update-inventory-item.dto';
import { UpdateStorageLocationDto } from './dto/update-storage-location.dto';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto';

type TransactionClient = Prisma.TransactionClient;

type StockStatus = 'OK' | 'LOW' | 'OUT';

type NormalizedMovementInput = {
  warehouseId: string;
  inventoryItemId: string;
  movementType: InventoryMovementType;
  quantity: number;
  storageLocation?: string | null;
  storageLocationId?: string | null;
  destinationWarehouseId?: string | null;
  destinationStorageLocation?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  notes?: string | null;
  performedBy?: string | null;
  reversalOfMovementId?: string | null;
};

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
        rate:
          input.rate !== undefined
            ? new Prisma.Decimal(input.rate)
            : undefined,
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
        rate:
          input.rate !== undefined
            ? new Prisma.Decimal(input.rate)
            : undefined,
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

  async deleteInventoryItem(organizationId: string, inventoryItemId: string) {
    await this.ensureInventoryItemExists(organizationId, inventoryItemId);

    const [stockCount, movementCount] = await this.prisma.$transaction([
      this.prisma.inventoryStock.count({
        where: {
          organizationId,
          inventoryItemId,
        },
      }),
      this.prisma.inventoryMovement.count({
        where: {
          organizationId,
          inventoryItemId,
        },
      }),
    ]);

    if (stockCount > 0 || movementCount > 0) {
      throw new ConflictException(
        'Inventory item cannot be deleted because it already has stock or movement history',
      );
    }

    return this.prisma.inventoryItem.delete({
      where: { id: inventoryItemId },
    });
  }

  async listStorageLocations(organizationId: string, warehouseId: string) {
    await this.ensureWarehouseExists(organizationId, warehouseId);

    return this.prisma.storageLocation.findMany({
      where: {
        warehouseId,
      },
      orderBy: [{ status: 'asc' }, { code: 'asc' }],
    });
  }

  async createStorageLocation(
    organizationId: string,
    warehouseId: string,
    input: CreateStorageLocationDto,
  ) {
    await this.ensureWarehouseExists(organizationId, warehouseId);

    try {
      return await this.prisma.storageLocation.create({
        data: {
          warehouseId,
          code: input.code,
          name: input.name,
          description: input.description,
          status: input.status ?? StorageLocationStatus.ACTIVE,
        },
      });
    } catch (error) {
      this.throwUniqueConstraintError(
        error,
        'Storage location code already exists for this warehouse',
      );
      throw error;
    }
  }

  async updateStorageLocation(
    organizationId: string,
    warehouseId: string,
    id: string,
    input: UpdateStorageLocationDto,
  ) {
    await this.ensureStorageLocationExists(organizationId, warehouseId, id);

    try {
      return await this.prisma.storageLocation.update({
        where: { id },
        data: {
          code: input.code,
          name: input.name,
          description: input.description,
          status: input.status,
        },
      });
    } catch (error) {
      this.throwUniqueConstraintError(
        error,
        'Storage location code already exists for this warehouse',
      );
      throw error;
    }
  }

  async getWarehouseStock(organizationId: string, warehouseId: string) {
    await this.ensureWarehouseExists(organizationId, warehouseId);

    const rows = await this.prisma.inventoryStock.findMany({
      where: {
        organizationId,
        warehouseId,
      },
      include: {
        inventoryItem: true,
        warehouse: true,
        storageLocationRef: true,
      },
      orderBy: [
        { inventoryItem: { name: 'asc' } },
        { storageLocation: 'asc' },
      ],
    });

    return rows.map((row) => ({
      ...row,
      stockStatus: this.getStockStatus(
        Number(row.quantityOnHand),
        row.inventoryItem.minThreshold,
      ),
    }));
  }

  async getWarehouseStockAlerts(organizationId: string, warehouseId: string) {
    const rows = await this.getWarehouseStock(organizationId, warehouseId);

    return rows
      .filter((row) => row.stockStatus !== 'OK')
      .map((row) => ({
        id: row.id,
        stockStatus: row.stockStatus,
        quantityOnHand: row.quantityOnHand,
        minStockThreshold: row.inventoryItem.minThreshold,
        itemName: row.inventoryItem.name,
        itemCode: row.inventoryItem.itemCode,
        warehouseName: row.warehouse.name,
        warehouseId: row.warehouseId,
        inventoryItemId: row.inventoryItemId,
        storageLocation: row.storageLocation,
      }));
  }

  async listInventoryMovements(
    organizationId: string,
    warehouseId?: string,
    inventoryItemId?: string,
  ) {
    if (warehouseId) {
      await this.ensureWarehouseExists(organizationId, warehouseId);
    }

    const movements = await this.prisma.inventoryMovement.findMany({
      where: {
        organizationId,
        ...(warehouseId
          ? {
              OR: [{ warehouseId }, { destinationWarehouseId: warehouseId }],
            }
          : {}),
        ...(inventoryItemId ? { inventoryItemId } : {}),
      },
      include: {
        warehouse: true,
        destinationWarehouse: true,
        inventoryItem: true,
        reversedByMovement: {
          select: { id: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return movements.map((movement) =>
      this.serializeMovementWithReversal(movement),
    );
  }

  async createInventoryMovement(
    organizationId: string,
    input: CreateInventoryMovementDto,
  ) {
    await this.ensureWarehouseExists(organizationId, input.warehouseId);
    await this.ensureInventoryItemExists(organizationId, input.inventoryItemId);

    if (input.movementType === InventoryMovementType.TRANSFER) {
      if (!input.destinationWarehouseId) {
        throw new BadRequestException(
          'Destination warehouse is required for transfer movements',
        );
      }

      if (input.destinationWarehouseId === input.warehouseId) {
        throw new BadRequestException(
          'Source and destination warehouses must be different for a transfer',
        );
      }

      await this.ensureWarehouseExists(organizationId, input.destinationWarehouseId);
    }

    return this.prisma.$transaction(async (tx) => {
      const movement = await this.recordInventoryMovement(tx, organizationId, {
        warehouseId: input.warehouseId,
        inventoryItemId: input.inventoryItemId,
        movementType: input.movementType,
        quantity: input.quantity,
        storageLocation: input.storageLocation ?? null,
        storageLocationId: input.storageLocationId ?? null,
        destinationWarehouseId: input.destinationWarehouseId ?? null,
        destinationStorageLocation: input.destinationStorageLocation ?? null,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        notes: input.notes ?? null,
        performedBy: input.performedBy ?? null,
      });

      return movement;
    });
  }

  async reverseInventoryMovement(
    organizationId: string,
    movementId: string,
    input: ReverseInventoryMovementDto,
  ) {
    const originalMovement = await this.prisma.inventoryMovement.findFirst({
      where: {
        id: movementId,
        organizationId,
      },
      include: {
        reversedByMovement: {
          select: { id: true },
        },
      },
    });

    if (!originalMovement) {
      throw new NotFoundException('Inventory movement not found');
    }

    if (originalMovement.reversedByMovement) {
      throw new ConflictException('Inventory movement has already been reversed');
    }

    return this.prisma.$transaction(async (tx) => {
      const reversalInput = this.buildReversalMovementInput(
        originalMovement,
        input.notes,
      );

      const movement = await this.recordInventoryMovement(
        tx,
        organizationId,
        reversalInput,
      );

      return movement;
    });
  }

  private buildReversalMovementInput(
    movement: {
      id: string;
      warehouseId: string;
      inventoryItemId: string;
      movementType: InventoryMovementType;
      quantity: Prisma.Decimal;
      storageLocation: string | null;
      storageLocationId: string | null;
      destinationWarehouseId: string | null;
      destinationStorageLocation: string | null;
      referenceType: string | null;
      referenceId: string | null;
      performedBy: string | null;
    },
    notes: string,
  ): NormalizedMovementInput {
    const quantity = Number(movement.quantity);

    switch (movement.movementType) {
      case InventoryMovementType.INBOUND:
        return {
          warehouseId: movement.warehouseId,
          inventoryItemId: movement.inventoryItemId,
          movementType: InventoryMovementType.OUTBOUND,
          quantity,
          storageLocation: movement.storageLocation,
          storageLocationId: movement.storageLocationId,
          referenceType: movement.referenceType,
          referenceId: movement.referenceId,
          performedBy: movement.performedBy,
          notes,
          reversalOfMovementId: movement.id,
        };
      case InventoryMovementType.OUTBOUND:
        return {
          warehouseId: movement.warehouseId,
          inventoryItemId: movement.inventoryItemId,
          movementType: InventoryMovementType.INBOUND,
          quantity,
          storageLocation: movement.storageLocation,
          storageLocationId: movement.storageLocationId,
          referenceType: movement.referenceType,
          referenceId: movement.referenceId,
          performedBy: movement.performedBy,
          notes,
          reversalOfMovementId: movement.id,
        };
      case InventoryMovementType.ADJUSTMENT:
        return {
          warehouseId: movement.warehouseId,
          inventoryItemId: movement.inventoryItemId,
          movementType: InventoryMovementType.ADJUSTMENT,
          quantity: quantity * -1,
          storageLocation: movement.storageLocation,
          storageLocationId: movement.storageLocationId,
          referenceType: movement.referenceType,
          referenceId: movement.referenceId,
          performedBy: movement.performedBy,
          notes,
          reversalOfMovementId: movement.id,
        };
      case InventoryMovementType.TRANSFER:
        if (!movement.destinationWarehouseId) {
          throw new ConflictException(
            'Transfer movement cannot be reversed because it has no destination warehouse',
          );
        }

        return {
          warehouseId: movement.destinationWarehouseId,
          inventoryItemId: movement.inventoryItemId,
          movementType: InventoryMovementType.TRANSFER,
          quantity,
          storageLocation: movement.destinationStorageLocation,
          destinationWarehouseId: movement.warehouseId,
          destinationStorageLocation: movement.storageLocation,
          referenceType: movement.referenceType,
          referenceId: movement.referenceId,
          performedBy: movement.performedBy,
          notes,
          reversalOfMovementId: movement.id,
        };
      default:
        throw new BadRequestException('Unsupported movement type');
    }
  }

  private async recordInventoryMovement(
    tx: TransactionClient,
    organizationId: string,
    input: NormalizedMovementInput,
  ) {
    const sourceLocation = await this.resolveSourceStorageLocation(
      tx,
      organizationId,
      input.warehouseId,
      input.storageLocationId ?? null,
      input.storageLocation ?? null,
    );

    const sourceStock = await this.findStockRow(
      tx,
      organizationId,
      input.warehouseId,
      input.inventoryItemId,
      sourceLocation.storageLocation,
      sourceLocation.storageLocationId,
    );

    const currentQuantity = sourceStock ? Number(sourceStock.quantityOnHand) : 0;
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

    if (sourceStock) {
      await tx.inventoryStock.update({
        where: { id: sourceStock.id },
        data: {
          quantityOnHand: new Prisma.Decimal(nextQuantity),
          storageLocationId:
            sourceStock.storageLocationId ?? sourceLocation.storageLocationId,
        },
      });
    } else {
      await tx.inventoryStock.create({
        data: {
          organizationId,
          warehouseId: input.warehouseId,
          inventoryItemId: input.inventoryItemId,
          storageLocation: sourceLocation.storageLocation,
          storageLocationId: sourceLocation.storageLocationId,
          quantityOnHand: new Prisma.Decimal(nextQuantity),
        },
      });
    }

    if (
      input.movementType === InventoryMovementType.TRANSFER &&
      input.destinationWarehouseId
    ) {
      const destinationStock = await this.findStockRow(
        tx,
        organizationId,
        input.destinationWarehouseId,
        input.inventoryItemId,
        input.destinationStorageLocation ?? null,
        null,
      );
      const destinationCurrentQuantity = destinationStock
        ? Number(destinationStock.quantityOnHand)
        : 0;

      if (destinationStock) {
        await tx.inventoryStock.update({
          where: { id: destinationStock.id },
          data: {
            quantityOnHand: new Prisma.Decimal(
              destinationCurrentQuantity + input.quantity,
            ),
          },
        });
      } else {
        await tx.inventoryStock.create({
          data: {
            organizationId,
            warehouseId: input.destinationWarehouseId,
            inventoryItemId: input.inventoryItemId,
            storageLocation: input.destinationStorageLocation ?? null,
            quantityOnHand: new Prisma.Decimal(input.quantity),
          },
        });
      }
    }

    const movement = await tx.inventoryMovement.create({
      data: {
        organizationId,
        warehouseId: input.warehouseId,
        inventoryItemId: input.inventoryItemId,
        movementType: input.movementType,
        quantity: new Prisma.Decimal(input.quantity),
        storageLocation: sourceLocation.storageLocation,
        storageLocationId: sourceLocation.storageLocationId,
        destinationWarehouseId: input.destinationWarehouseId,
        destinationStorageLocation: input.destinationStorageLocation,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        notes: input.notes,
        performedBy: input.performedBy,
        reversalOfMovementId: input.reversalOfMovementId,
      },
      include: {
        warehouse: true,
        destinationWarehouse: true,
        inventoryItem: true,
        reversedByMovement: {
          select: { id: true },
        },
      },
    });

    return this.serializeMovementWithReversal(movement);
  }

  private async resolveSourceStorageLocation(
    tx: TransactionClient,
    organizationId: string,
    warehouseId: string,
    storageLocationId: string | null,
    storageLocation: string | null,
  ) {
    if (!storageLocationId) {
      return {
        storageLocationId: null,
        storageLocation,
      };
    }

    const location = await tx.storageLocation.findFirst({
      where: {
        id: storageLocationId,
        warehouseId,
        warehouse: {
          organizationId,
        },
      },
    });

    if (!location) {
      throw new NotFoundException('Storage location not found');
    }

    return {
      storageLocationId: location.id,
      storageLocation: storageLocation ?? location.code,
    };
  }

  private async findStockRow(
    tx: TransactionClient,
    organizationId: string,
    warehouseId: string,
    inventoryItemId: string,
    storageLocation: string | null,
    storageLocationId: string | null,
  ) {
    const rows = await tx.inventoryStock.findMany({
      where: {
        organizationId,
        warehouseId,
        inventoryItemId,
        storageLocation,
      },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });

    if (!rows.length) {
      return null;
    }

    if (storageLocationId) {
      return (
        rows.find((row) => row.storageLocationId === storageLocationId) ??
        rows.find((row) => row.storageLocationId === null) ??
        rows[0]
      );
    }

    return rows.find((row) => row.storageLocationId === null) ?? rows[0];
  }

  private getStockStatus(
    quantityOnHand: number,
    minThreshold: Prisma.Decimal | null,
  ): StockStatus {
    if (quantityOnHand === 0) {
      return 'OUT';
    }

    const threshold = minThreshold ? Number(minThreshold) : 0;

    if (quantityOnHand <= threshold) {
      return 'LOW';
    }

    return 'OK';
  }

  private serializeMovementWithReversal(
    movement: {
      reversedByMovement?: { id: string } | null;
      [key: string]: unknown;
    },
  ) {
    const reversedByMovementId = movement.reversedByMovement?.id ?? null;
    const { reversedByMovement, ...rest } = movement;

    return {
      ...rest,
      reversedByMovementId,
    };
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

  private throwUniqueConstraintError(error: unknown, message: string) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(message);
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

  private async ensureStorageLocationExists(
    organizationId: string,
    warehouseId: string,
    storageLocationId: string,
  ) {
    const storageLocation = await this.prisma.storageLocation.findFirst({
      where: {
        id: storageLocationId,
        warehouseId,
        warehouse: {
          organizationId,
        },
      },
    });

    if (!storageLocation) {
      throw new NotFoundException('Storage location not found');
    }

    return storageLocation;
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
