import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import type { TrackingRole } from '../interfaces/tracking-token-payload.interface';

export class CreateTrackingTestTokenDto {
  @ApiProperty()
  @IsString()
  shipmentId!: string;

  @ApiProperty()
  @IsUUID()
  organizationId!: string;

  @ApiProperty({ enum: ['rider', 'customer'] })
  @IsIn(['rider', 'customer'])
  role!: TrackingRole;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  destinationLatitude!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  destinationLongitude!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subject?: string;
}
