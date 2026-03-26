import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsEmail,
  IsInt,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RegisterOrganizationDocumentDto {
  @ApiProperty({
    description: 'Use values like GST_CERTIFICATE, PAN_CARD, or CIN_CERTIFICATE',
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
  @IsInt()
  @Min(0)
  fileSize?: number;
}

export class RegisterCompanyAdminDto {
  @ApiProperty()
  @IsString()
  fullName!: string;

  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  phone!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'password must contain at least one letter and one number',
  })
  password!: string;

  @ApiProperty()
  @IsString()
  organizationName!: string;

  @ApiProperty()
  @IsString()
  legalName!: string;

  @ApiProperty()
  @IsEmail()
  organizationEmail!: string;

  @ApiProperty()
  @IsString()
  organizationPhone!: string;

  @ApiProperty()
  @IsString()
  gstNumber!: string;

  @ApiProperty()
  @IsString()
  panNumber!: string;

  @ApiProperty()
  @IsString()
  cinNumber!: string;

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

  @ApiProperty({
    type: () => [RegisterOrganizationDocumentDto],
    description:
      'At least one uploaded registration document such as GST, PAN, or CIN file is required',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RegisterOrganizationDocumentDto)
  registrationDocuments!: RegisterOrganizationDocumentDto[];
}
