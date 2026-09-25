import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StorageLocationStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class CreateStorageLocationDto {
  @ApiProperty()
  @IsString()
  code!: string;

  @ApiProperty()
  @IsString()
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: StorageLocationStatus })
  @IsOptional()
  @IsEnum(StorageLocationStatus)
  status?: StorageLocationStatus;
}
