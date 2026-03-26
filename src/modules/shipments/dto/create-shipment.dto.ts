import {
  EventSource,
  ShipmentMode,
  ShipmentPriority,
  ShipmentStatus,
  ShipmentType,
  StopType,
} from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateShipmentItemDto {
  @ApiProperty()
  @IsString()
  description!: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  quantity!: number;

  @ApiProperty()
  @IsString()
  unit!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  weight?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  volume?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  declaredValue?: number;
}

export class CreateShipmentStopDto {
  @ApiProperty()
  @IsNumber()
  @Min(1)
  stopSequence!: number;

  @ApiProperty({ enum: StopType })
  @IsEnum(StopType)
  stopType!: StopType;

  @ApiProperty()
  @IsString()
  locationName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  addressLine1?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  addressLine2?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  postalCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  plannedArrivalAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  plannedDepartureAt?: string;
}

export class CreateShipmentDto {
  @ApiProperty()
  @IsUUID()
  organizationId!: string;

  @ApiPropertyOptional({
    description:
      'Required for BUSINESS shipments. Omit for INTERNAL shipments.',
  })
  @IsOptional()
  @IsUUID()
  companyClientId?: string;

  @ApiProperty({ enum: ShipmentMode })
  @IsEnum(ShipmentMode)
  shipmentMode!: ShipmentMode;

  @ApiProperty({ enum: ShipmentType })
  @IsEnum(ShipmentType)
  shipmentType!: ShipmentType;

  @ApiPropertyOptional({ enum: ShipmentPriority })
  @IsOptional()
  @IsEnum(ShipmentPriority)
  priority?: ShipmentPriority;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  shipmentCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  sourceLocationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  destinationLocationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  plannedPickupAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  plannedDeliveryAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  invoiceNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  invoiceDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  invoiceAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  internalSenderName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  internalSenderPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  internalSenderDepartment?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  internalReceiverName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  internalReceiverPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  internalReceiverDepartment?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ type: () => [CreateShipmentItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateShipmentItemDto)
  items?: CreateShipmentItemDto[];

  @ApiPropertyOptional({ type: () => [CreateShipmentStopDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateShipmentStopDto)
  stops?: CreateShipmentStopDto[];

  @ApiPropertyOptional({ enum: ShipmentStatus })
  @IsOptional()
  @IsEnum(ShipmentStatus)
  initialStatus?: ShipmentStatus;

  @ApiPropertyOptional({ enum: EventSource })
  @IsOptional()
  @IsEnum(EventSource)
  eventSource?: EventSource;
}
