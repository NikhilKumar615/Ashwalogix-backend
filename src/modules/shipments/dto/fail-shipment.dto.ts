import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class FailShipmentDto {
  @ApiProperty()
  @IsUUID()
  organizationId!: string;

  @ApiProperty()
  @IsString()
  reason!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
