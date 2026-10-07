import { ProofType } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

// Drivers send whatever contact number is on the shipment ("+91 98xxx xxxxx",
// "022-4000-1000", "--").  The receiver phone is informational, so normalise
// it to a 10-digit number and drop it when it cannot be one rather than
// rejecting the whole proof submission.
function normalizeReceiverPhone(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let digits = value.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits.length === 10 ? digits : undefined;
}

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

  @ApiPropertyOptional({
    type: [String],
    description:
      'All photo document ids for this proof in one request. Each photo is linked as its own proof row (same as repeated single-photo submissions), and the full list is recorded on the status event.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  photoDocumentIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  signatureDocumentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  receiverName?: string;

  @ApiPropertyOptional()
  @Transform(({ value }) => normalizeReceiverPhone(value))
  @IsOptional()
  @IsString()
  @Matches(/^\d{10}$/, {
    message: 'receiverPhone must contain exactly 10 digits',
  })
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
