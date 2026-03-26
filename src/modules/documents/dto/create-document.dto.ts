import { DocumentEntityType, DocumentStatus } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateDocumentDto {
  @ApiProperty()
  @IsUUID()
  organizationId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  shipmentId?: string;

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

  @ApiProperty()
  @IsString()
  storageBucket!: string;

  @ApiProperty()
  @IsString()
  storageKey!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mimeType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  fileSize?: number;

  @ApiPropertyOptional({ enum: DocumentStatus })
  @IsOptional()
  @IsEnum(DocumentStatus)
  status?: DocumentStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  uploadedBy?: string;
}
