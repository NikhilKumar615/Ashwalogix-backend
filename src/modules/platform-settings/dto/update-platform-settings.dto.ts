import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

export class UpdatePlatformSettingsDto {
  @ApiProperty({
    type: Object,
    description: 'Complete superadmin platform settings payload.',
  })
  @IsObject()
  config!: Record<string, unknown>;
}
