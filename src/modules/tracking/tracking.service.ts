import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TRACKING_EVENT_BUS } from '../../shared/kafka/kafka.constants';
import type { TrackingEventBus } from '../../shared/kafka/interfaces/tracking-event-bus.interface';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TRACKING_PUB_SUB } from './tracking.constants';
import { TrackingLocationUpdateDto } from './dto/tracking-location-update.dto';
import type { TrackingPubSub } from './interfaces/tracking-pub-sub.interface';
import type { TrackingTokenPayload } from './interfaces/tracking-token-payload.interface';
import { TrackingKalmanService } from './tracking-kalman.service';
import { TrackingRoadEtaService } from './tracking-road-eta.service';
import { TrackingValidationService } from './tracking-validation.service';

@Injectable()
export class TrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kalmanService: TrackingKalmanService,
    private readonly trackingRoadEtaService: TrackingRoadEtaService,
    private readonly trackingValidationService: TrackingValidationService,
    @Inject(TRACKING_PUB_SUB)
    private readonly trackingPubSub: TrackingPubSub,
    @Inject(TRACKING_EVENT_BUS)
    private readonly trackingEventBus: TrackingEventBus,
  ) {}

  async assertTrackingAccess(token: TrackingTokenPayload) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: token.shipmentId },
      select: {
        id: true,
        organizationId: true,
      },
    });

    if (!shipment) {
      throw new NotFoundException('Shipment not found');
    }

    if (shipment.organizationId !== token.organizationId) {
      throw new ForbiddenException('Tracking token does not match shipment organization');
    }

    return shipment;
  }

  async processLocationUpdate(
    token: TrackingTokenPayload,
    location: TrackingLocationUpdateDto,
  ) {
    const eventTimestamp = location.timestamp
      ? new Date(location.timestamp)
      : new Date();

    const validated = this.trackingValidationService.validate(
      token.shipmentId,
      location,
      eventTimestamp.getTime(),
    );

    if (!validated.accepted && !this.trackingValidationService.hasState(token.shipmentId)) {
      throw new BadRequestException(
        `Rejected ${validated.rejectionReason ?? 'invalid'} tracking ping before any good position was available`,
      );
    }

    const effectiveLocation = validated.location;
    const smoothed = validated.accepted
      ? this.kalmanService.update(
          token.shipmentId,
          {
            latitude: effectiveLocation.latitude,
            longitude: effectiveLocation.longitude,
            accuracy: effectiveLocation.accuracy,
          },
          eventTimestamp.getTime(),
        )
      : {
          latitude: effectiveLocation.latitude,
          longitude: effectiveLocation.longitude,
        };

    this.trackingValidationService.rememberGoodOutput(
      token.shipmentId,
      {
        latitude: smoothed.latitude,
        longitude: smoothed.longitude,
        accuracy: effectiveLocation.accuracy,
        speed: effectiveLocation.speed,
        heading: effectiveLocation.heading,
      },
      eventTimestamp.getTime(),
    );

    const etaSeconds = await this.trackingRoadEtaService.resolveEtaSeconds(
      token.shipmentId,
      smoothed,
      token.destination,
    );

    const update = {
      shipmentId: token.shipmentId,
      latitude: smoothed.latitude,
      longitude: smoothed.longitude,
      etaSeconds,
      timestamp: eventTimestamp.toISOString(),
    };

    await this.trackingPubSub.publish({
      shipmentId: token.shipmentId,
      event: 'tracking:update',
      payload: update,
    });

    await this.trackingEventBus.publishRiderLocation({
      eventId: randomUUID(),
      shipmentId: token.shipmentId,
      organizationId: token.organizationId,
      riderUserId: token.sub,
      destination: token.destination,
      location: {
        latitude: smoothed.latitude,
        longitude: smoothed.longitude,
        accuracy: effectiveLocation.accuracy,
        speed: effectiveLocation.speed,
        heading: effectiveLocation.heading,
      },
      timestamp: eventTimestamp.toISOString(),
    });

    return update;
  }

  clearTrackingState(shipmentId: string) {
    this.kalmanService.clear(shipmentId);
    this.trackingValidationService.clear(shipmentId);
  }
}
