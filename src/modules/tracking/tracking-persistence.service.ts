import { Injectable, Logger } from '@nestjs/common';
import { Prisma, ShipmentStatus, TrackingSessionStatus } from '@prisma/client';
import type { RiderLocationEvent } from '../../shared/kafka/interfaces/tracking-event-bus.interface';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ShipmentsService } from '../shipments/shipments.service';

/**
 * Shipment statuses during which a driver is expected to be moving with the
 * shipment and live tracking pings / tracking sessions are accepted
 * (EN_ROUTE_PICKUP .. AT_DELIVERY inclusive).
 */
export const TRACKABLE_SHIPMENT_STATUSES: ReadonlySet<ShipmentStatus> =
  new Set<ShipmentStatus>([
    ShipmentStatus.EN_ROUTE_PICKUP,
    ShipmentStatus.AT_PICKUP,
    ShipmentStatus.PICKED_UP,
    ShipmentStatus.IN_TRANSIT,
    ShipmentStatus.AT_DELIVERY,
  ]);

export function isTrackableShipmentStatus(status: string | null | undefined) {
  return !!status && TRACKABLE_SHIPMENT_STATUSES.has(status as ShipmentStatus);
}

/** Accept client timestamps up to this far in the future (clock skew). */
const MAX_FUTURE_SKEW_MS = 2 * 60_000;

/**
 * Persists rider location events as tracking points. Used both by the Kafka DB
 * sink consumer and directly by the tracking service when the event bus is
 * unavailable, so points are never silently dropped.
 */
@Injectable()
export class TrackingPersistenceService {
  private readonly logger = new Logger(TrackingPersistenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shipmentsService: ShipmentsService,
  ) {}

  async persist(event: RiderLocationEvent): Promise<boolean> {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: event.shipmentId },
      select: {
        id: true,
        organizationId: true,
        status: true,
        currentDriverId: true,
        currentTrackingSessionId: true,
      },
    });

    if (!shipment || shipment.organizationId !== event.organizationId) {
      return false;
    }

    // Re-check the lifecycle: pings that arrive after delivery/cancellation
    // (or before the trip starts) must not open a new tracking session.
    if (!isTrackableShipmentStatus(shipment.status)) {
      this.logger.debug(
        `Skipping tracking persistence for shipment ${event.shipmentId}: status ${String(shipment.status)} is not trackable`,
      );
      return false;
    }

    if (!shipment.currentDriverId) {
      this.logger.warn(
        `Skipping tracking persistence for shipment ${event.shipmentId}: no current driver is assigned`,
      );
      return false;
    }

    const activeSession = shipment.currentTrackingSessionId
      ? await this.prisma.trackingSession.findUnique({
          where: { id: shipment.currentTrackingSessionId },
          select: { id: true, status: true },
        })
      : null;

    const trackingSessionId =
      activeSession && activeSession.status === TrackingSessionStatus.ACTIVE
        ? activeSession.id
        : (
            await this.shipmentsService.startTrackingSession(event.shipmentId, {
              organizationId: event.organizationId,
              driverId: shipment.currentDriverId,
            })
          ).id;

    await this.prisma.trackingPoint.create({
      data: {
        organizationId: event.organizationId,
        trackingSessionId,
        shipmentId: event.shipmentId,
        driverId: shipment.currentDriverId,
        latitude: new Prisma.Decimal(event.location.latitude),
        longitude: new Prisma.Decimal(event.location.longitude),
        speed: this.toDecimal(event.location.speed),
        heading: this.toDecimal(event.location.heading),
        accuracy: this.toDecimal(event.location.accuracy),
        // Preserve the device-reported ping time when it is sane.
        recordedAt: this.resolveRecordedAt(event.timestamp),
      },
    });

    return true;
  }

  private toDecimal(value: number | undefined | null) {
    return typeof value === 'number' && Number.isFinite(value)
      ? new Prisma.Decimal(value)
      : undefined;
  }

  private resolveRecordedAt(timestamp: string | undefined) {
    const now = Date.now();
    if (!timestamp) {
      return new Date(now);
    }

    const parsed = new Date(timestamp).getTime();
    if (!Number.isFinite(parsed) || parsed > now + MAX_FUTURE_SKEW_MS) {
      return new Date(now);
    }

    return new Date(parsed);
  }
}
