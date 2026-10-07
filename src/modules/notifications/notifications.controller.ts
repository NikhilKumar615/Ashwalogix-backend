import { Body, Controller, Delete, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { RegisterPushDeviceDto } from './dto/register-push-device.dto';
import { UnregisterPushDeviceDto } from './dto/unregister-push-device.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('devices')
  @ApiOperation({ summary: 'Register this device for push notifications' })
  @ApiBody({ type: RegisterPushDeviceDto })
  registerDevice(
    @Body() body: RegisterPushDeviceDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.notificationsService.registerPushDevice(user.sub, body);
  }

  @Delete('devices')
  @ApiOperation({
    summary:
      'Unregister this device from push notifications (call on sign-out)',
  })
  @ApiBody({ type: UnregisterPushDeviceDto })
  unregisterDevice(
    @Body() body: UnregisterPushDeviceDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.notificationsService.unregisterPushDevice(
      user.sub,
      body.expoPushToken,
    );
  }
}
