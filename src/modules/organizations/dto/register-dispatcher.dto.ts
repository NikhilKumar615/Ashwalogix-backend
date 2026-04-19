import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SectionAccessDto } from './section-access.dto';

export class RegisterDispatcherDto {
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

  @ApiPropertyOptional({ type: SectionAccessDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SectionAccessDto)
  sectionAccess?: SectionAccessDto;
}
