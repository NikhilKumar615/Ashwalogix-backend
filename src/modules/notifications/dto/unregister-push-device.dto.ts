import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class UnregisterPushDeviceDto {
  @ApiProperty()
  @IsString()
  @Matches(/^ExponentPushToken\[[^\]]+\]$|^ExpoPushToken\[[^\]]+\]$/)
  expoPushToken!: string;
}
