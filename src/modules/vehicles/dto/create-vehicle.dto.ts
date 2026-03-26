import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleOwnerType, VehicleStatus } from '@prisma/client';
import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateVehicleDto {
  @ApiProperty()
  @IsString()
  vehicleNumber!: string;

  @ApiProperty()
  @IsString()
  vehicleType!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  capacityWeight?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  capacityVolume?: number;

  @ApiPropertyOptional({ enum: VehicleOwnerType })
  @IsOptional()
  @IsEnum(VehicleOwnerType)
  ownerType?: VehicleOwnerType;

  @ApiPropertyOptional({ enum: VehicleStatus })
  @IsOptional()
  @IsEnum(VehicleStatus)
  status?: VehicleStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
