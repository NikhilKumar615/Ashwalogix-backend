import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

export class SectionAccessDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  fullAccess?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sections?: string[];
}
