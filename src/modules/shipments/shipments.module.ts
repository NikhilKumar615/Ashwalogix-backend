import { Module } from '@nestjs/common';
import { KafkaModule } from '../../shared/kafka/kafka.module';
import { AuthModule } from '../auth/auth.module';
import { ShipmentsController } from './shipments.controller';
import { ShipmentsService } from './shipments.service';

@Module({
  imports: [AuthModule, KafkaModule],
  controllers: [ShipmentsController],
  providers: [ShipmentsService],
  exports: [ShipmentsService],
})
export class ShipmentsModule {}
