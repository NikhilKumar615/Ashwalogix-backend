import { ProofType } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateProofOfDeliveryDto {
  @ApiProperty()
  @IsUUID()
  organizationId!: string;

  @ApiProperty({ enum: ProofType })
  @IsEnum(ProofType)
  proofType!: ProofType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  photoDocumentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  signatureDocumentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  receiverName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  receiverPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  remarks?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  capturedBy?: string;
}
