import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class ReverseInventoryMovementDto {
  @ApiProperty()
  @IsString()
  notes!: string;
}
