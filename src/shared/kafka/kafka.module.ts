import { Global, Module } from '@nestjs/common';
import { TRACKING_EVENT_BUS } from './kafka.constants';
import { KafkaEventBusService } from './kafka-event-bus.service';

@Global()
@Module({
  providers: [
    KafkaEventBusService,
    {
      provide: TRACKING_EVENT_BUS,
      useExisting: KafkaEventBusService,
    },
  ],
  exports: [KafkaEventBusService, TRACKING_EVENT_BUS],
})
export class KafkaModule {}
