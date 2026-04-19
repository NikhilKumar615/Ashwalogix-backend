import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EmploymentType } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SectionAccessDto } from './section-access.dto';

export class RegisterCompanyDriverDto {
  @ApiProperty()
  @IsString()
  fullName!: string;

  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  phone!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(8)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'password must contain at least one letter and one number',
  })
  password?: string;

  @ApiProperty({ enum: EmploymentType })
  @IsEnum(EmploymentType)
  employmentType!: EmploymentType;

  @ApiProperty()
  @IsString()
  licenseNumber!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  driverCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  homeBase?: string;

  @ApiPropertyOptional({ type: SectionAccessDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SectionAccessDto)
  sectionAccess?: SectionAccessDto;
}
