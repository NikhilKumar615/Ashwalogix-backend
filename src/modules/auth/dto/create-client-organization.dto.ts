import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ClientStatus,
  PaymentCollectionMethod,
  SubscriptionPaymentStatus,
  SubscriptionStatus,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { ClientOrganizationBranchDto } from './client-organization-branch.dto';

export class CreateClientOrganizationDto {
  @ApiProperty()
  @IsString()
  organizationName!: string;

  @ApiProperty()
  @IsString()
  legalName!: string;

  @ApiProperty()
  @IsString()
  companyType!: string;

  @ApiProperty()
  @IsString()
  clientSegment!: string;

  @ApiProperty()
  @IsString()
  industry!: string;

  @ApiProperty({ enum: ClientStatus })
  @IsEnum(ClientStatus)
  clientStatus!: ClientStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tags?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty()
  @IsString()
  panNumber!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  gstNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  billingCycle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  creditAccount?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  priorityClient?: boolean;

  @ApiProperty()
  @IsString()
  contactPerson!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  designation?: string;

  @ApiProperty()
  @IsString()
  contactPhone!: string;

  @ApiProperty()
  @IsEmail()
  contactEmail!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  subscriptionPlanId?: string;

  @ApiPropertyOptional({ enum: SubscriptionStatus })
  @IsOptional()
  @IsEnum(SubscriptionStatus)
  subscriptionStatus?: SubscriptionStatus;

  @ApiPropertyOptional({ enum: SubscriptionPaymentStatus })
  @IsOptional()
  @IsEnum(SubscriptionPaymentStatus)
  subscriptionPaymentStatus?: SubscriptionPaymentStatus;

  @ApiPropertyOptional({ enum: PaymentCollectionMethod })
  @IsOptional()
  @IsEnum(PaymentCollectionMethod)
  paymentCollectionMethod?: PaymentCollectionMethod;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subscriptionNotes?: string;

  @ApiProperty({
    type: () => [ClientOrganizationBranchDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ClientOrganizationBranchDto)
  branches!: ClientOrganizationBranchDto[];
}
