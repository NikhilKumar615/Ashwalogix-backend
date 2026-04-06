import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { PlatformRole } from '@prisma/client';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto';
import { PlatformSettingsService } from './platform-settings.service';

@ApiTags('Platform Settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(PlatformRole.SUPER_ADMIN)
@Controller('platform-settings')
export class PlatformSettingsController {
  constructor(private readonly platformSettingsService: PlatformSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get superadmin platform settings' })
  async getSettings() {
    return this.platformSettingsService.getSettings();
  }

  @Get('plans')
  @ApiOperation({ summary: 'List configured subscription plans' })
  async listPlans(@Query('enabledOnly') enabledOnly?: string) {
    return this.platformSettingsService.listPlans(enabledOnly === 'true');
  }

  @Put()
  @ApiOperation({ summary: 'Update superadmin platform settings' })
  @ApiBody({ type: UpdatePlatformSettingsDto })
  async updateSettings(
    @Body() body: UpdatePlatformSettingsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.platformSettingsService.updateSettings(body.config, user.sub);
  }
}
