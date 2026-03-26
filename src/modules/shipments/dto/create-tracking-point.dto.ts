import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsUUID } from 'class-validator';

export class CreateTrackingPointDto {
  @ApiProperty()
  @IsUUID()
  organizationId!: string;

  @ApiProperty()
  @IsUUID()
  driverId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  trackingSessionId?: string;

  @ApiProperty()
  @IsNumber()
  latitude!: number;

  @ApiProperty()
  @IsNumber()
  longitude!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  speed?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  heading?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  accuracy?: number;
}
