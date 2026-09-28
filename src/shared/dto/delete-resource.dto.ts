import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class DeleteResourceDto {
  @ApiProperty({ description: 'Reason recorded in the deletion audit trail' })
  @IsString()
  @MinLength(3)
  reason!: string;
}
