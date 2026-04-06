import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TRACKING_EVENT_BUS } from '../../shared/kafka/kafka.constants';
import type { TrackingEventBus } from '../../shared/kafka/interfaces/tracking-event-bus.interface';

@Injectable()
export class TrackingNotificationConsumerService implements OnModuleInit {
  private readonly logger = new Logger(TrackingNotificationConsumerService.name);

  constructor(
    @Inject(TRACKING_EVENT_BUS)
    private readonly trackingEventBus: TrackingEventBus,
  ) {}

  async onModuleInit() {
    await this.trackingEventBus.registerOrderEventConsumer(
      'tracking-notification-service',
      async (event) => {
        this.logger.log(
          `Notification service processed order.events for shipment ${event.shipmentId}: ${event.eventType}`,
        );
      },
    );
  }
}
