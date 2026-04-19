import { ApiPropertyOptional } from '@nestjs/swagger';
import { MembershipStatus, UserStatus } from '@prisma/client';
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

export class UpdateOrganizationUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fullName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(8)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'password must contain at least one letter and one number',
  })
  password?: string;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  userStatus?: UserStatus;

  @ApiPropertyOptional({ enum: MembershipStatus })
  @IsOptional()
  @IsEnum(MembershipStatus)
  membershipStatus?: MembershipStatus;

  @ApiPropertyOptional({ type: SectionAccessDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SectionAccessDto)
  sectionAccess?: SectionAccessDto;
}
