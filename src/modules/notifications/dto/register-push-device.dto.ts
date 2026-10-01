import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

export class RegisterPushDeviceDto {
  @ApiProperty()
  @IsString()
  @Matches(/^ExponentPushToken\[[^\]]+\]$|^ExpoPushToken\[[^\]]+\]$/)
  expoPushToken!: string;

  @ApiPropertyOptional({ enum: ['android', 'ios'] })
  @IsOptional()
  @IsIn(['android', 'ios'])
  platform?: 'android' | 'ios';
}
