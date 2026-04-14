import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TRACKING_EVENT_BUS } from '../../shared/kafka/kafka.constants';
import type { TrackingEventBus } from '../../shared/kafka/interfaces/tracking-event-bus.interface';
import { TrackingRoadEtaService } from './tracking-road-eta.service';

@Injectable()
export class TrackingEtaEngineConsumerService implements OnModuleInit {
  private readonly logger = new Logger(TrackingEtaEngineConsumerService.name);

  constructor(
    @Inject(TRACKING_EVENT_BUS)
    private readonly trackingEventBus: TrackingEventBus,
    private readonly trackingRoadEtaService: TrackingRoadEtaService,
  ) {}

  async onModuleInit() {
    await this.trackingEventBus.registerRiderLocationConsumer(
      'tracking-eta-engine',
      async (event) => {
        if (!event.destination) {
          this.logger.debug(
            `ETA engine skipped rider.location for shipment ${event.shipmentId}: destination coordinates are unavailable`,
          );
          return;
        }

        const etaSeconds = await this.trackingRoadEtaService.resolveEtaSeconds(
          event.shipmentId,
          {
            latitude: event.location.latitude,
            longitude: event.location.longitude,
          },
          event.destination,
        );

        this.logger.log(
          `ETA engine processed rider.location for shipment ${event.shipmentId}: ${etaSeconds}s`,
        );
      },
    );
  }
}
