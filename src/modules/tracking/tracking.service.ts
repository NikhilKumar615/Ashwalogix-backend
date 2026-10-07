import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TRACKING_EVENT_BUS } from '../../shared/kafka/kafka.constants';
import type {
  RiderLocationEvent,
  TrackingEventBus,
} from '../../shared/kafka/interfaces/tracking-event-bus.interface';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TRACKING_PUB_SUB } from './tracking.constants';
import { TrackingLocationUpdateDto } from './dto/tracking-location-update.dto';
import type { TrackingPubSub } from './interfaces/tracking-pub-sub.interface';
import type { TrackingTokenPayload } from './interfaces/tracking-token-payload.interface';
import { TrackingKalmanService } from './tracking-kalman.service';
import {
  isTrackableShipmentStatus,
  TrackingPersistenceService,
} from './tracking-persistence.service';
import { TrackingRoadEtaService } from './tracking-road-eta.service';
import { TrackingValidationService } from './tracking-validation.service';

/** How long a shipment status lookup is cached per shipment for ping checks. */
const STATUS_CACHE_TTL_MS = 10_000;
/** Accept client timestamps up to this far in the future (clock skew). */
const MAX_FUTURE_SKEW_MS = 2 * 60_000;

export type TrackingLocationAck = {
  shipmentId: string;
  latitude: number;
  longitude: number;
  etaSeconds: number | null;
  timestamp: string;
  /** false when the ping was filtered out (accuracy/speed); position is the last good one. */
  accepted?: boolean;
  rejectionReason?: 'accuracy' | 'speed';
};

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);
  private readonly statusCache = new Map<
    string,
    { status: string; organizationId: string; expiresAt: number }
  >();
  private readonly lastAckByShipment = new Map<string, TrackingLocationAck>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly kalmanService: TrackingKalmanService,
    private readonly trackingRoadEtaService: TrackingRoadEtaService,
    private readonly trackingValidationService: TrackingValidationService,
    @Inject(TRACKING_PUB_SUB)
    private readonly trackingPubSub: TrackingPubSub,
    @Inject(TRACKING_EVENT_BUS)
    private readonly trackingEventBus: TrackingEventBus,
    private readonly trackingPersistenceService?: TrackingPersistenceService,
  ) {}

  async assertTrackingAccess(token: TrackingTokenPayload) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: token.shipmentId },
      select: {
        id: true,
        organizationId: true,
        status: true,
      },
    });

    if (!shipment) {
      throw new NotFoundException('Shipment not found');
    }

    if (shipment.organizationId !== token.organizationId) {
      throw new ForbiddenException(
        'Tracking token does not match shipment organization',
      );
    }

    if (shipment.status) {
      this.cacheStatus(shipment.id, shipment.status, shipment.organizationId);
    }

    return shipment;
  }

  async processLocationUpdate(
    token: TrackingTokenPayload,
    location: TrackingLocationUpdateDto,
  ): Promise<TrackingLocationAck> {
    await this.assertShipmentTrackable(token);

    const eventTimestamp = this.resolveEventTimestamp(location.timestamp);

    const validated = this.trackingValidationService.validate(
      token.shipmentId,
      location,
      eventTimestamp.getTime(),
    );

    if (!validated.accepted) {
      if (!this.trackingValidationService.hasState(token.shipmentId)) {
        throw new BadRequestException(
          `Rejected ${validated.rejectionReason ?? 'invalid'} tracking ping before any good position was available`,
        );
      }

      // Rejected pings are neither re-stored nor re-broadcast (that would
      // create duplicate points) and they do not refresh the last good
      // timestamp. Acknowledge with the last good position instead.
      const previous = this.lastAckByShipment.get(token.shipmentId);
      return {
        shipmentId: token.shipmentId,
        latitude: previous?.latitude ?? validated.location.latitude,
        longitude: previous?.longitude ?? validated.location.longitude,
        etaSeconds: previous?.etaSeconds ?? null,
        timestamp:
          previous?.timestamp ??
          validated.location.timestamp ??
          eventTimestamp.toISOString(),
        accepted: false,
        rejectionReason: validated.rejectionReason,
      };
    }

    if (validated.recovered) {
      // Large jump after a GPS gap: restart smoothing from the new fix.
      this.kalmanService.clear(token.shipmentId);
    }

    const effectiveLocation = validated.location;
    const smoothed = this.kalmanService.update(
      token.shipmentId,
      {
        latitude: effectiveLocation.latitude,
        longitude: effectiveLocation.longitude,
        accuracy: effectiveLocation.accuracy,
      },
      eventTimestamp.getTime(),
    );

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

    const etaSeconds = token.destination
      ? await this.trackingRoadEtaService.resolveEtaSeconds(
          token.shipmentId,
          smoothed,
          token.destination,
        )
      : null;

    const update = {
      shipmentId: token.shipmentId,
      latitude: smoothed.latitude,
      longitude: smoothed.longitude,
      etaSeconds,
      timestamp: eventTimestamp.toISOString(),
    };
    this.lastAckByShipment.set(token.shipmentId, update);

    await this.trackingPubSub.publish({
      shipmentId: token.shipmentId,
      event: 'tracking:update',
      payload: update,
    });

    const riderLocationEvent: RiderLocationEvent = {
      eventId: randomUUID(),
      shipmentId: token.shipmentId,
      organizationId: token.organizationId,
      riderUserId: token.sub,
      destination: token.destination ?? null,
      location: {
        latitude: smoothed.latitude,
        longitude: smoothed.longitude,
        accuracy: effectiveLocation.accuracy,
        speed: effectiveLocation.speed,
        heading: effectiveLocation.heading,
      },
      timestamp: eventTimestamp.toISOString(),
    };

    let published = false;
    try {
      published =
        await this.trackingEventBus.publishRiderLocation(riderLocationEvent);
    } catch (error) {
      this.logger.warn(
        `Event bus publish failed for shipment ${token.shipmentId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    if (!published) {
      // Bus unavailable: persist directly so the tracking history is kept.
      await this.persistDirectly(riderLocationEvent);
    }

    return { ...update, accepted: true };
  }

  clearTrackingState(shipmentId: string) {
    this.kalmanService.clear(shipmentId);
    this.trackingValidationService.clear(shipmentId);
    this.lastAckByShipment.delete(shipmentId);
    this.statusCache.delete(shipmentId);
  }

  private async assertShipmentTrackable(token: TrackingTokenPayload) {
    const now = Date.now();
    let cached = this.statusCache.get(token.shipmentId);

    if (!cached || cached.expiresAt <= now) {
      const shipment = await this.prisma.shipment.findUnique({
        where: { id: token.shipmentId },
        select: { id: true, organizationId: true, status: true },
      });

      if (!shipment) {
        this.statusCache.delete(token.shipmentId);
        throw new NotFoundException('Shipment not found');
      }

      cached = this.cacheStatus(
        shipment.id,
        shipment.status,
        shipment.organizationId,
      );
    }

    if (cached.organizationId !== token.organizationId) {
      throw new ForbiddenException(
        'Tracking token does not match shipment organization',
      );
    }

    if (!isTrackableShipmentStatus(cached.status)) {
      throw new BadRequestException(
        'Live tracking is only accepted while the shipment is in progress',
      );
    }
  }

  private cacheStatus(
    shipmentId: string,
    status: string,
    organizationId: string,
  ) {
    const entry = {
      status,
      organizationId,
      expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
    };
    this.statusCache.set(shipmentId, entry);
    return entry;
  }

  private resolveEventTimestamp(timestamp?: string) {
    const now = Date.now();
    if (!timestamp) {
      return new Date(now);
    }

    const parsed = new Date(timestamp).getTime();
    if (!Number.isFinite(parsed) || parsed > now + MAX_FUTURE_SKEW_MS) {
      return new Date(now);
    }

    // Preserve the device timestamp (offline buffering sends older pings).
    return new Date(parsed);
  }

  private async persistDirectly(event: RiderLocationEvent) {
    if (!this.trackingPersistenceService) {
      return;
    }

    try {
      await this.trackingPersistenceService.persist(event);
    } catch (error) {
      this.logger.error(
        `Direct tracking persistence failed for shipment ${event.shipmentId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
