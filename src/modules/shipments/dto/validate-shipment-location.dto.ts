import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';

export class ValidateShipmentLocationDto {
  @ApiProperty()
  @IsUUID()
  organizationId!: string;

  @ApiProperty({ description: 'Street address, building, gate, or landmark' })
  @IsString()
  addressLine1!: string;

  @ApiProperty()
  @IsString()
  city!: string;

  @ApiProperty({ description: 'Six digit Indian PIN code' })
  @Matches(/^\d{6}$/, { message: 'postalCode must contain exactly 6 digits' })
  postalCode!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  locationName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  state?: string;
}
