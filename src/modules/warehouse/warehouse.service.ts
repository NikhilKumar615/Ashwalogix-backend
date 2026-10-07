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

const MIN_MOVEMENT_QUANTITY = '0.01';
const MAX_CODE_GENERATION_ATTEMPTS = 5;

type NormalizedMovementInput = {
  warehouseId: string;
  inventoryItemId: string;
  movementType: InventoryMovementType;
  /** Signed only for ADJUSTMENT (negative reduces stock). */
  quantity: Prisma.Decimal;
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
    // Generated codes can collide under concurrent creates: retry on P2002.
    for (let attempt = 0; ; attempt += 1) {
      const warehouseCode = await this.generateWarehouseCode(
        organizationId,
        attempt,
      );
      try {
        return await this.createWarehouseWithCode(
          organizationId,
          warehouseCode,
          input,
        );
      } catch (error) {
        const isUniqueViolation =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002';
        if (!isUniqueViolation) {
          throw error;
        }
        if (attempt + 1 >= MAX_CODE_GENERATION_ATTEMPTS) {
          throw new ConflictException(
            'Could not allocate a unique warehouse code. Please try again.',
          );
        }
      }
    }
  }

  private createWarehouseWithCode(
    organizationId: string,
    warehouseCode: string,
    input: CreateWarehouseDto,
  ) {
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

  async deleteWarehouse(
    organizationId: string,
    warehouseId: string,
    reason: string,
    deletedByUserId: string,
  ) {
    const warehouse = await this.getWarehouseById(organizationId, warehouseId);
    const [stockCount, movementCount, destinationMovementCount] =
      await Promise.all([
        this.prisma.inventoryStock.count({
          where: { organizationId, warehouseId },
        }),
        this.prisma.inventoryMovement.count({
          where: { organizationId, warehouseId },
        }),
        this.prisma.inventoryMovement.count({
          where: { organizationId, destinationWarehouseId: warehouseId },
        }),
      ]);
    if (stockCount || movementCount || destinationMovementCount) {
      throw new BadRequestException(
        'Warehouses with inventory or movement history cannot be deleted. Empty or transfer stock first.',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.storageLocation.deleteMany({ where: { warehouseId } });
      await tx.deletionAudit.create({
        data: {
          organizationId,
          entityType: 'WAREHOUSE',
          entityId: warehouse.id,
          entityLabel: warehouse.name,
          reason: reason.trim(),
          deletedByUserId,
        },
      });
      await tx.warehouse.delete({ where: { id: warehouseId } });
    });
    return { id: warehouseId, deleted: true };
  }

  private async generateWarehouseCode(organizationId: string, offset = 0) {
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
      }, 0) +
      1 +
      offset;

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

    return this.withUniqueConstraintMessage(
      'A warehouse with this code already exists',
      () =>
        this.prisma.warehouse.update({
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
        }),
    );
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
    return this.withUniqueConstraintMessage(
      'An inventory item with this item code already exists',
      () =>
        this.prisma.inventoryItem.create({
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
        }),
    );
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

    return this.withUniqueConstraintMessage(
      'An inventory item with this item code already exists',
      () =>
        this.prisma.inventoryItem.update({
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
        }),
    );
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
      orderBy: [{ inventoryItem: { name: 'asc' } }, { storageLocation: 'asc' }],
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
    const warehouse = await this.ensureWarehouseExists(
      organizationId,
      input.warehouseId,
    );
    const inventoryItem = await this.ensureInventoryItemExists(
      organizationId,
      input.inventoryItemId,
    );
    const quantity = this.resolveMovementQuantity(input);
    const addsStockToSource =
      input.movementType === InventoryMovementType.INBOUND ||
      (input.movementType === InventoryMovementType.ADJUSTMENT &&
        quantity.gt(0));

    if (addsStockToSource) {
      this.assertCanReceiveStock(warehouse, inventoryItem);
    }

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

      const destinationWarehouse = await this.ensureWarehouseExists(
        organizationId,
        input.destinationWarehouseId,
      );
      this.assertCanReceiveStock(destinationWarehouse, inventoryItem);
    }

    return this.prisma.$transaction(async (tx) => {
      const movement = await this.recordInventoryMovement(tx, organizationId, {
        warehouseId: input.warehouseId,
        inventoryItemId: input.inventoryItemId,
        movementType: input.movementType,
        quantity,
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

  /**
   * Quantities are positive, except ADJUSTMENT which is signed: a negative
   * quantity or adjustmentDirection=DECREASE reduces stock.
   */
  private resolveMovementQuantity(input: CreateInventoryMovementDto) {
    const raw = new Prisma.Decimal(input.quantity);

    if (input.movementType === InventoryMovementType.ADJUSTMENT) {
      if (raw.abs().lt(MIN_MOVEMENT_QUANTITY)) {
        throw new BadRequestException(
          `Adjustment quantity must be at least ${MIN_MOVEMENT_QUANTITY}`,
        );
      }
      if (input.adjustmentDirection === 'DECREASE') {
        return raw.abs().negated();
      }
      if (input.adjustmentDirection === 'INCREASE') {
        return raw.abs();
      }
      return raw;
    }

    if (raw.lt(MIN_MOVEMENT_QUANTITY)) {
      throw new BadRequestException(
        `Quantity must be at least ${MIN_MOVEMENT_QUANTITY}`,
      );
    }

    return raw;
  }

  private assertCanReceiveStock(
    warehouse: { name: string; status: WarehouseStatus },
    inventoryItem: { name: string; status: InventoryItemStatus },
  ) {
    if (warehouse.status !== WarehouseStatus.ACTIVE) {
      throw new BadRequestException(
        `Warehouse ${warehouse.name} is inactive and cannot receive stock`,
      );
    }

    if (inventoryItem.status !== InventoryItemStatus.ACTIVE) {
      throw new BadRequestException(
        `Inventory item ${inventoryItem.name} is inactive and cannot receive stock`,
      );
    }
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
      throw new ConflictException(
        'Inventory movement has already been reversed',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
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
    } catch (error) {
      // reversalOfMovementId is unique: a concurrent reversal won the race.
      this.throwUniqueConstraintError(
        error,
        'Inventory movement has already been reversed',
      );
      throw error;
    }
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
    const quantity = new Prisma.Decimal(movement.quantity);

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
          quantity: quantity.negated(),
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
    const quantity = new Prisma.Decimal(input.quantity);
    const sourceDelta = this.calculateSourceDelta(input.movementType, quantity);

    const sourceLocation = await this.resolveSourceStorageLocation(
      tx,
      organizationId,
      input.warehouseId,
      input.storageLocationId ?? null,
      input.storageLocation ?? null,
      // Reversals restore a previous state, so they may touch inactive bins.
      sourceDelta.gt(0) && !input.reversalOfMovementId,
    );

    const isTransfer =
      input.movementType === InventoryMovementType.TRANSFER &&
      !!input.destinationWarehouseId;
    const destinationStorageLocation =
      input.destinationStorageLocation?.trim() || null;

    // Serialize concurrent movements on the same stock rows (incl. NULL
    // storage locations, which the unique index does not cover). Locks are
    // taken in a stable order so opposite transfers cannot deadlock.
    const lockKeys = [
      this.stockLockKey(
        input.warehouseId,
        input.inventoryItemId,
        sourceLocation.storageLocation,
      ),
      ...(isTransfer
        ? [
            this.stockLockKey(
              input.destinationWarehouseId as string,
              input.inventoryItemId,
              destinationStorageLocation,
            ),
          ]
        : []),
    ].sort();
    for (const key of lockKeys) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'inventory_stock'}), hashtext(${key}))`;
    }

    await this.applyStockDelta(tx, {
      organizationId,
      warehouseId: input.warehouseId,
      inventoryItemId: input.inventoryItemId,
      storageLocation: sourceLocation.storageLocation,
      storageLocationId: sourceLocation.storageLocationId,
      delta: sourceDelta,
    });

    if (isTransfer) {
      await this.applyStockDelta(tx, {
        organizationId,
        warehouseId: input.destinationWarehouseId as string,
        inventoryItemId: input.inventoryItemId,
        storageLocation: destinationStorageLocation,
        storageLocationId: null,
        delta: quantity,
      });
    }

    const movement = await tx.inventoryMovement.create({
      data: {
        organizationId,
        warehouseId: input.warehouseId,
        inventoryItemId: input.inventoryItemId,
        movementType: input.movementType,
        quantity,
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

  private stockLockKey(
    warehouseId: string,
    inventoryItemId: string,
    storageLocation: string | null,
  ) {
    return `${warehouseId}:${inventoryItemId}:${storageLocation ?? '\u0000null'}`;
  }

  /**
   * Applies a signed quantity change to a stock row atomically: decrements
   * are conditional on enough stock (no read-compute-write in JS), so
   * concurrent movements can never drive stock negative or lose updates.
   */
  private async applyStockDelta(
    tx: TransactionClient,
    input: {
      organizationId: string;
      warehouseId: string;
      inventoryItemId: string;
      storageLocation: string | null;
      storageLocationId: string | null;
      delta: Prisma.Decimal;
    },
  ) {
    const stockRow = await this.findStockRow(
      tx,
      input.organizationId,
      input.warehouseId,
      input.inventoryItemId,
      input.storageLocation,
      input.storageLocationId,
    );

    if (!stockRow) {
      if (input.delta.lt(0)) {
        throw new BadRequestException(
          'Inventory movement would make stock negative',
        );
      }

      try {
        await tx.inventoryStock.create({
          data: {
            organizationId: input.organizationId,
            warehouseId: input.warehouseId,
            inventoryItemId: input.inventoryItemId,
            storageLocation: input.storageLocation,
            storageLocationId: input.storageLocationId,
            quantityOnHand: input.delta,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new ConflictException(
            'Stock was updated concurrently. Please retry the movement.',
          );
        }
        throw error;
      }
      return;
    }

    const storageLocationIdPatch =
      !stockRow.storageLocationId && input.storageLocationId
        ? { storageLocationId: input.storageLocationId }
        : {};

    if (input.delta.gte(0)) {
      await tx.inventoryStock.update({
        where: { id: stockRow.id },
        data: {
          quantityOnHand: { increment: input.delta },
          ...storageLocationIdPatch,
        },
      });
      return;
    }

    const decrement = input.delta.abs();
    const result = await tx.inventoryStock.updateMany({
      where: {
        id: stockRow.id,
        quantityOnHand: { gte: decrement },
      },
      data: {
        quantityOnHand: { decrement },
        ...storageLocationIdPatch,
      },
    });

    if (result.count === 0) {
      throw new BadRequestException(
        'Inventory movement would make stock negative',
      );
    }
  }

  private async resolveSourceStorageLocation(
    tx: TransactionClient,
    organizationId: string,
    warehouseId: string,
    storageLocationId: string | null,
    storageLocation: string | null,
    requireActive = false,
  ) {
    const normalizedStorageLocation = storageLocation?.trim() || null;

    if (!storageLocationId) {
      return {
        storageLocationId: null,
        storageLocation: normalizedStorageLocation,
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

    if (requireActive && location.status !== StorageLocationStatus.ACTIVE) {
      throw new BadRequestException(
        `Storage location ${location.code} is inactive and cannot receive stock`,
      );
    }

    return {
      storageLocationId: location.id,
      storageLocation: normalizedStorageLocation ?? location.code,
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
        // Explicit NULL handling: `storageLocation: null` matches IS NULL.
        storageLocation: storageLocation === null ? null : storageLocation,
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

  private serializeMovementWithReversal(movement: {
    reversedByMovement?: { id: string } | null;
    [key: string]: unknown;
  }) {
    const reversedByMovementId = movement.reversedByMovement?.id ?? null;
    const rest: Record<string, unknown> = { ...movement };
    delete rest.reversedByMovement;

    return {
      ...rest,
      reversedByMovementId,
    };
  }

  /** Signed change applied to the source stock row for a movement. */
  private calculateSourceDelta(
    movementType: InventoryMovementType,
    quantity: Prisma.Decimal,
  ) {
    switch (movementType) {
      case InventoryMovementType.INBOUND:
        return quantity;
      case InventoryMovementType.OUTBOUND:
        return quantity.negated();
      case InventoryMovementType.ADJUSTMENT:
        return quantity;
      case InventoryMovementType.TRANSFER:
        return quantity.negated();
      default:
        throw new BadRequestException('Unsupported movement type');
    }
  }

  private async withUniqueConstraintMessage<T>(
    message: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.throwUniqueConstraintError(error, message);
      throw error;
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

  private async ensureWarehouseExists(
    organizationId: string,
    warehouseId: string,
  ) {
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
