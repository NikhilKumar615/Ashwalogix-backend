import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class DeleteShipmentDto {
  @ApiPropertyOptional({
    description:
      'Reason recorded in the deletion audit trail. Optional for backward compatibility.',
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}
