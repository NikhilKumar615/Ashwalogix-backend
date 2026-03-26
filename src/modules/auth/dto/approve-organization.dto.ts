import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ApproveOrganizationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
