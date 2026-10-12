import { Injectable, Logger } from '@nestjs/common';
import { StopType } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  NotificationInput,
  NotificationsService,
} from './notifications.service';

/** Times in notification text are shown in Indian Standard Time. */
const DISPLAY_TIME_ZONE = 'Asia/Kolkata';

export function formatNotificationTime(value: Date | null | undefined) {
  if (!value) return null;
  return value.toLocaleString('en-IN', {
    timeZone: DISPLAY_TIME_ZONE,
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function formatNotificationDate(value: Date) {
  return value.toLocaleDateString('en-IN', {
    timeZone: DISPLAY_TIME_ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

type ShipmentSummary = {
  id: string;
  organizationId: string;
  shipmentCode: string;
  plannedPickupAt: Date | null;
  plannedDeliveryAt: Date | null;
  pickup: string | null;
  delivery: string | null;
};

export type ScheduleChange = {
  pickupBefore: Date | null;
  pickupAfter: Date | null;
  deliveryBefore: Date | null;
  deliveryAfter: Date | null;
};

/**
 * Builds the driver-facing trip notifications (text + deep-link data) and
 * hands them to NotificationsService. All methods are fire-and-forget safe:
 * they never throw.
 */
@Injectable()
export class DriverNotificationsService {
  private readonly logger = new Logger(DriverNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async shipmentAssigned(driverId: string, shipmentId: string) {
    await this.send(driverId, shipmentId, (s) => ({
      type: 'SHIPMENT_ASSIGNED',
      title: `New trip assigned · ${s.shipmentCode}`,
      body: [
        s.pickup ? `Pickup at ${s.pickup}` : 'A new trip is ready for you',
        s.plannedPickupAt
          ? `on ${formatNotificationTime(s.plannedPickupAt)}`
          : null,
        s.delivery ? `→ ${s.delivery}` : null,
      ]
        .filter(Boolean)
        .join(' ')
        .concat('.'),
    }));
  }

  async shipmentUnassigned(driverId: string, shipmentId: string) {
    await this.send(driverId, shipmentId, (s) => ({
      type: 'SHIPMENT_UNASSIGNED',
      title: `Trip reassigned · ${s.shipmentCode}`,
      body: 'Operations moved this trip to another driver. You no longer need to do it.',
    }));
  }

  async vehicleChanged(driverId: string, shipmentId: string) {
    await this.send(driverId, shipmentId, (s) => ({
      type: 'SHIPMENT_UPDATED',
      title: `Vehicle changed · ${s.shipmentCode}`,
      body: 'Operations changed the vehicle for this trip. Open the trip to check the details.',
    }));
  }

  async routeChanged(driverId: string, shipmentId: string) {
    await this.send(driverId, shipmentId, (s) => ({
      type: 'SHIPMENT_UPDATED',
      title: `Trip details changed · ${s.shipmentCode}`,
      body: [
        'Operations updated the pickup or delivery address.',
        s.pickup && s.delivery ? `Now ${s.pickup} → ${s.delivery}.` : null,
      ]
        .filter(Boolean)
        .join(' '),
    }));
  }

  async shipmentRescheduled(
    driverId: string,
    shipmentId: string,
    change: ScheduleChange,
  ) {
    const pickupMoved = !sameTime(change.pickupBefore, change.pickupAfter);
    const deliveryMoved = !sameTime(
      change.deliveryBefore,
      change.deliveryAfter,
    );
    if (!pickupMoved && !deliveryMoved) return;

    await this.send(driverId, shipmentId, (s) => {
      const parts: string[] = [];
      if (pickupMoved) {
        parts.push(
          change.pickupAfter
            ? `Pickup now ${formatNotificationTime(change.pickupAfter)}${
                change.pickupBefore
                  ? ` (was ${formatNotificationTime(change.pickupBefore)})`
                  : ''
              }.`
            : 'Pickup time removed — operations will confirm a new time.',
        );
      }
      if (deliveryMoved) {
        parts.push(
          change.deliveryAfter
            ? `Delivery by ${formatNotificationTime(change.deliveryAfter)}${
                change.deliveryBefore
                  ? ` (was ${formatNotificationTime(change.deliveryBefore)})`
                  : ''
              }.`
            : 'Delivery time removed — operations will confirm a new time.',
        );
      }
      return {
        type: 'SHIPMENT_RESCHEDULED',
        title: `${pickupMoved ? 'Pickup' : 'Delivery'} rescheduled · ${s.shipmentCode}`,
        body: parts.join(' '),
      };
    });
  }

  async shipmentCancelled(driverId: string, shipmentId: string) {
    await this.send(driverId, shipmentId, (s) => ({
      type: 'SHIPMENT_CANCELLED',
      title: `Trip cancelled · ${s.shipmentCode}`,
      body: 'Operations cancelled this trip. Do not go to the pickup. Contact operations if you are already on the way.',
    }));
  }

  async pickupReminder(driverId: string, shipmentId: string) {
    await this.send(driverId, shipmentId, (s) => ({
      type: 'PICKUP_REMINDER',
      title: `Pickup soon · ${s.shipmentCode}`,
      body: [
        s.pickup ? `Pickup at ${s.pickup}` : 'Your pickup',
        s.plannedPickupAt
          ? `is at ${formatNotificationTime(s.plannedPickupAt)}.`
          : 'is coming up.',
        'Start the trip when you head out.',
      ].join(' '),
      // One reminder per planned pickup time (a reschedule earns a new one).
      dedupeKey: `pickup-reminder:${s.id}:${s.plannedPickupAt?.toISOString() ?? 'none'}`,
    }));
  }

  private async send(
    driverId: string | null | undefined,
    shipmentId: string,
    build: (
      shipment: ShipmentSummary,
    ) => Omit<NotificationInput, 'data' | 'organizationId'>,
  ) {
    if (!driverId) return;
    try {
      const shipment = await this.loadShipment(shipmentId);
      if (!shipment) return;
      const message = build(shipment);
      await this.notifications.notifyDriver(driverId, {
        ...message,
        organizationId: shipment.organizationId,
        data: { shipmentId: shipment.id, shipmentCode: shipment.shipmentCode },
      });
    } catch (error) {
      this.logger.warn(
        `Driver notification for shipment ${shipmentId} failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  private async loadShipment(
    shipmentId: string,
  ): Promise<ShipmentSummary | null> {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: {
        id: true,
        organizationId: true,
        shipmentCode: true,
        plannedPickupAt: true,
        plannedDeliveryAt: true,
        stops: {
          orderBy: { stopSequence: 'asc' },
          select: { stopType: true, locationName: true, city: true },
        },
      },
    });
    if (!shipment) return null;

    const label = (stop?: { locationName: string; city: string | null }) =>
      stop
        ? [stop.locationName, stop.city]
            .filter(
              (part, index, all) =>
                part && all.findIndex((p) => p === part) === index,
            )
            .join(', ')
        : null;
    const pickups = shipment.stops.filter(
      (s) => s.stopType === StopType.PICKUP,
    );
    const deliveries = shipment.stops.filter(
      (s) => s.stopType === StopType.DELIVERY,
    );

    return {
      id: shipment.id,
      organizationId: shipment.organizationId,
      shipmentCode: shipment.shipmentCode,
      plannedPickupAt: shipment.plannedPickupAt,
      plannedDeliveryAt: shipment.plannedDeliveryAt,
      pickup: label(pickups[0]),
      delivery: label(deliveries[deliveries.length - 1]),
    };
  }
}

function sameTime(a: Date | null, b: Date | null) {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}
