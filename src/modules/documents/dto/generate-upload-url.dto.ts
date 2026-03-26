import { DocumentEntityType } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

export class GenerateUploadUrlDto {
  @ApiProperty()
  @IsUUID()
  organizationId!: string;

  @ApiProperty({ enum: DocumentEntityType })
  @IsEnum(DocumentEntityType)
  entityType!: DocumentEntityType;

  @ApiProperty()
  @IsUUID()
  entityId!: string;

  @ApiProperty()
  @IsString()
  documentType!: string;

  @ApiProperty()
  @IsString()
  fileName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mimeType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  shipmentId?: string;
}
