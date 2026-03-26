import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DriverLicenseType,
  FuelType,
  Gender,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

export class IndependentDriverDocumentDto {
  @ApiProperty({
    description:
      'Examples: RC_DOCUMENT, VEHICLE_INSURANCE_DOCUMENT, PERMIT_DOCUMENT, FITNESS_CERTIFICATE, POLLUTION_CERTIFICATE, DRIVING_LICENSE_PHOTO, AADHAAR_CARD, PAN_CARD, DRIVER_PHOTO, PROFILE_PHOTO',
  })
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
  @IsNumber()
  @Min(0)
  fileSize?: number;
}

export class RegisterIndependentDriverDto {
  @ApiProperty()
  @IsString()
  fullName!: string;

  @ApiProperty({
    description: 'Primary login/contact number for the driver',
  })
  @IsString()
  phone!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiProperty()
  @IsString()
  addressLine1!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  addressLine2?: string;

  @ApiProperty()
  @IsString()
  city!: string;

  @ApiProperty()
  @IsString()
  state!: string;

  @ApiProperty()
  @IsString()
  postalCode!: string;

  @ApiProperty()
  @IsString()
  country!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  homeBaseLocation?: string;

  @ApiProperty()
  @IsString()
  licenseNumber!: string;

  @ApiProperty()
  @IsDateString()
  licenseExpiry!: string;

  @ApiPropertyOptional({ enum: DriverLicenseType })
  @IsOptional()
  @IsEnum(DriverLicenseType)
  licenseType?: DriverLicenseType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  licenseIssueDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  licenseIssuingState?: string;

  @ApiPropertyOptional({
    description: 'At least one of aadhaarNumber or panNumber must be provided',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{12}$/, {
    message: 'aadhaarNumber must be a valid 12 digit number',
  })
  aadhaarNumber?: string;

  @ApiPropertyOptional({
    description: 'At least one of panNumber or aadhaarNumber must be provided',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/i, {
    message: 'panNumber must be a valid PAN format',
  })
  panNumber?: string;

  @ApiProperty()
  @IsString()
  vehicleNumber!: string;

  @ApiProperty()
  @IsString()
  vehicleType!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vehicleModel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  vehicleCapacity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vehicleOwnerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vehicleRegistrationState?: string;

  @ApiPropertyOptional({ enum: FuelType })
  @IsOptional()
  @IsEnum(FuelType)
  fuelType?: FuelType;

  @ApiProperty({
    type: () => [IndependentDriverDocumentDto],
    description:
      'Must include RC_DOCUMENT and DRIVING_LICENSE_PHOTO, and at least one of AADHAAR_CARD or PAN_CARD',
  })
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => IndependentDriverDocumentDto)
  uploadedDocuments!: IndependentDriverDocumentDto[];
}
