import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import { NotificationsService } from '../notifications/notifications.service';

export type DriverShipmentChange = {
  shipmentId: string;
  organizationId: string;
  change: 'assigned' | 'updated' | 'status_changed' | 'proof_added' | 'removed';
};

@Injectable()
export class DriverRealtimeService {
  private server?: Server;

  constructor(private readonly notificationsService: NotificationsService) {}

  attachServer(server: Server) {
    this.server = server;
  }

  notifyShipmentChange(driverId: string | null | undefined, change: DriverShipmentChange) {
    if (!driverId || !this.server) {
      return;
    }

    // The client receives only an invalidation signal, then reloads through
    // its normal authenticated API. This keeps the socket payload minimal and
    // ensures permissions are checked again before data is displayed.
    this.server.to(this.driverRoom(driverId)).emit('shipment:changed', {
      ...change,
      occurredAt: new Date().toISOString(),
    });

    if (change.change === 'assigned' || change.change === 'removed') {
      void this.notificationsService.sendDriverShipmentNotification(
        driverId,
        change.change === 'assigned' ? 'New shipment assigned' : 'Shipment assignment updated',
        change.change === 'assigned'
          ? 'A shipment is ready for you in Ashwa Logix.'
          : 'A shipment assignment has changed. Open Ashwa Logix to review it.',
        { shipmentId: change.shipmentId, change: change.change },
      );
    }
  }

  private driverRoom(driverId: string) {
    return `driver:${driverId}`;
  }
}
