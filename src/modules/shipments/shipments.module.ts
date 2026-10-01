import { Module } from '@nestjs/common';
import { KafkaModule } from '../../shared/kafka/kafka.module';
import { AuthModule } from '../auth/auth.module';
import { DriverRealtimeModule } from '../driver-realtime/driver-realtime.module';
import { MailModule } from '../mail/mail.module';
import { ShipmentsController } from './shipments.controller';
import { ShipmentsService } from './shipments.service';

@Module({
  imports: [AuthModule, KafkaModule, MailModule, DriverRealtimeModule],
  controllers: [ShipmentsController],
  providers: [ShipmentsService],
  exports: [ShipmentsService],
})
export class ShipmentsModule {}
