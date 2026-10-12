import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
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

  @Get()
  @ApiOperation({ summary: "The signed-in user's notifications, newest first" })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({
    name: 'before',
    required: false,
    description: 'ISO time; returns older notifications (use nextBefore)',
  })
  @ApiQuery({ name: 'unread', required: false, enum: ['true', 'false'] })
  list(
    @CurrentUser() user: JwtPayload,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('unread') unread?: string,
  ) {
    return this.notificationsService.listForUser(user.sub, {
      limit: limit ? Number(limit) : undefined,
      before,
      unreadOnly: unread === 'true',
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Number of unread notifications' })
  unreadCount(@CurrentUser() user: JwtPayload) {
    return this.notificationsService.unreadCount(user.sub);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark every notification as read' })
  markAllRead(@CurrentUser() user: JwtPayload) {
    return this.notificationsService.markAllRead(user.sub);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark one notification as read' })
  markRead(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.notificationsService.markRead(user.sub, id);
  }

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
