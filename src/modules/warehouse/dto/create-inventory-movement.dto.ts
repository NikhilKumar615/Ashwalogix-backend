import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InventoryMovementType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  NotEquals,
} from 'class-validator';

export const ADJUSTMENT_DIRECTIONS = ['INCREASE', 'DECREASE'] as const;
export type AdjustmentDirection = (typeof ADJUSTMENT_DIRECTIONS)[number];

export class CreateInventoryMovementDto {
  @ApiProperty()
  @IsUUID()
  warehouseId!: string;

  @ApiProperty()
  @IsUUID()
  inventoryItemId!: string;

  @ApiProperty({ enum: InventoryMovementType })
  @IsEnum(InventoryMovementType)
  movementType!: InventoryMovementType;

  @ApiProperty({
    description:
      'Quantity moved. Must be > 0, except for ADJUSTMENT where a negative value (or adjustmentDirection=DECREASE) reduces stock.',
  })
  @Type(() => Number)
  @IsNumber()
  @NotEquals(0)
  quantity!: number;

  @ApiPropertyOptional({
    enum: ADJUSTMENT_DIRECTIONS,
    description:
      'Only for ADJUSTMENT movements: DECREASE reduces stock by |quantity|. Defaults to the sign of quantity.',
  })
  @IsOptional()
  @IsIn(ADJUSTMENT_DIRECTIONS)
  adjustmentDirection?: AdjustmentDirection;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  storageLocation?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  storageLocationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  destinationWarehouseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  destinationStorageLocation?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  referenceType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  referenceId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  performedBy?: string;
}
