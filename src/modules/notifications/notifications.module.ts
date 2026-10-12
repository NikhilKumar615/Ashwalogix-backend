import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { DriverNotificationsService } from './driver-notifications.service';
import { NotificationRemindersService } from './notification-reminders.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [forwardRef(() => AuthModule), PrismaModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    DriverNotificationsService,
    NotificationRemindersService,
  ],
  exports: [NotificationsService, DriverNotificationsService],
})
export class NotificationsModule {}
