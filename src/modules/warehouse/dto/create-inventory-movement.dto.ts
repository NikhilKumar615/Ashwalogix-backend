import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InventoryMovementType } from '@prisma/client';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

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

  @ApiProperty()
  @IsNumber()
  @Min(0.01)
  quantity!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  storageLocation?: string;

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
