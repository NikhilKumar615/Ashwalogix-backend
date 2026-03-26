import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class StartTrackingSessionDto {
  @ApiProperty()
  @IsUUID()
  organizationId!: string;

  @ApiProperty()
  @IsUUID()
  driverId!: string;
}
