import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClientStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class CreateCompanyClientDto {
  @ApiProperty({ description: 'Business-facing code for this company client' })
  @IsString()
  companyClientCode!: string;

  @ApiProperty({ description: 'Display name of the company client' })
  @IsString()
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  legalName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  industry?: string;

  @ApiPropertyOptional({ enum: ClientStatus })
  @IsOptional()
  @IsEnum(ClientStatus)
  status?: ClientStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pan?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  gstin?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  creditTerms?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
