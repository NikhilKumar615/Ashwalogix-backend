import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';

export type DriverShipmentChange = {
  shipmentId: string;
  organizationId: string;
  change: 'assigned' | 'updated' | 'status_changed' | 'proof_added' | 'removed';
};

@Injectable()
export class DriverRealtimeService {
  private server?: Server;

  attachServer(server: Server) {
    this.server = server;
  }

  notifyShipmentChange(
    driverId: string | null | undefined,
    change: DriverShipmentChange,
  ) {
    if (!driverId || !this.server) {
      return;
    }

    // The client receives only an invalidation signal, then reloads through
    // its normal authenticated API. This keeps the socket payload minimal and
    // ensures permissions are checked again before data is displayed.
    // Push / inbox notifications are sent by DriverNotificationsService.
    this.server.to(this.driverRoom(driverId)).emit('shipment:changed', {
      ...change,
      occurredAt: new Date().toISOString(),
    });
  }

  private driverRoom(driverId: string) {
    return `driver:${driverId}`;
  }
}
