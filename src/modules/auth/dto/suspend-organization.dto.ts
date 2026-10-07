import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Body for POST /auth/organizations/:id/suspend and /reactivate. */
export class SuspendOrganizationDto {
  @ApiPropertyOptional({
    description: 'Why the organization status is being changed (logged).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
