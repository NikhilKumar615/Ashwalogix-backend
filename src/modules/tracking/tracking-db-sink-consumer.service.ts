import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TRACKING_EVENT_BUS } from '../../shared/kafka/kafka.constants';
import type {
  RiderLocationEvent,
  TrackingEventBus,
} from '../../shared/kafka/interfaces/tracking-event-bus.interface';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ShipmentsService } from '../shipments/shipments.service';

@Injectable()
export class TrackingDbSinkConsumerService implements OnModuleInit {
  private readonly logger = new Logger(TrackingDbSinkConsumerService.name);

  constructor(
    @Inject(TRACKING_EVENT_BUS)
    private readonly trackingEventBus: TrackingEventBus,
    private readonly prisma: PrismaService,
    private readonly shipmentsService: ShipmentsService,
  ) {}

  async onModuleInit() {
    await this.trackingEventBus.registerRiderLocationConsumer(
      'tracking-db-sink',
      async (event) => {
        await this.persist(event);
      },
    );
  }

  private async persist(event: RiderLocationEvent) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: event.shipmentId },
      select: {
        id: true,
        organizationId: true,
        currentDriverId: true,
        currentTrackingSessionId: true,
      },
    });

    if (!shipment || shipment.organizationId !== event.organizationId) {
      return;
    }

    if (!shipment.currentDriverId) {
      this.logger.warn(
        `Skipping Kafka tracking persistence for shipment ${event.shipmentId}: no current driver is assigned`,
      );
      return;
    }

    const trackingSession = shipment.currentTrackingSessionId
      ? { id: shipment.currentTrackingSessionId }
      : await this.shipmentsService.startTrackingSession(event.shipmentId, {
          organizationId: event.organizationId,
          driverId: shipment.currentDriverId,
        });

    await this.shipmentsService.addTrackingPoint(event.shipmentId, {
      organizationId: event.organizationId,
      driverId: shipment.currentDriverId,
      trackingSessionId: trackingSession.id,
      latitude: event.location.latitude,
      longitude: event.location.longitude,
      accuracy: event.location.accuracy,
      heading: event.location.heading,
      speed: event.location.speed,
    });
  }
}
