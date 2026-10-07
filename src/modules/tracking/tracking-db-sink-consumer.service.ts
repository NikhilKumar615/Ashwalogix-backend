import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { TRACKING_EVENT_BUS } from '../../shared/kafka/kafka.constants';
import type { TrackingEventBus } from '../../shared/kafka/interfaces/tracking-event-bus.interface';
import { TrackingPersistenceService } from './tracking-persistence.service';

@Injectable()
export class TrackingDbSinkConsumerService implements OnModuleInit {
  constructor(
    @Inject(TRACKING_EVENT_BUS)
    private readonly trackingEventBus: TrackingEventBus,
    private readonly trackingPersistenceService: TrackingPersistenceService,
  ) {}

  async onModuleInit() {
    await this.trackingEventBus.registerRiderLocationConsumer(
      'tracking-db-sink',
      async (event) => {
        // Status / driver / session checks are re-done inside persist() so a
        // late event after delivery can never open a new session.
        await this.trackingPersistenceService.persist(event);
      },
    );
  }
}
