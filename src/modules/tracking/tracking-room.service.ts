import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import type { TrackingRole } from './interfaces/tracking-token-payload.interface';
import type { TrackingBroadcastPayload } from './interfaces/tracking-pub-sub.interface';

@Injectable()
export class TrackingRoomService {
  private readonly customerSocketsByShipment = new Map<string, Set<string>>();
  private readonly socketState = new Map<
    string,
    { shipmentId: string; role: TrackingRole }
  >();
  private server?: Server;

  attachServer(server: Server) {
    this.server = server;
  }

  registerSocket(socketId: string, shipmentId: string, role: TrackingRole) {
    this.socketState.set(socketId, { shipmentId, role });

    if (role !== 'customer') {
      return;
    }

    const customers = this.customerSocketsByShipment.get(shipmentId) ?? new Set();
    customers.add(socketId);
    this.customerSocketsByShipment.set(shipmentId, customers);
  }

  unregisterSocket(socketId: string) {
    const state = this.socketState.get(socketId);

    if (!state) {
      return;
    }

    this.socketState.delete(socketId);

    if (state.role !== 'customer') {
      return;
    }

    const customers = this.customerSocketsByShipment.get(state.shipmentId);

    if (!customers) {
      return;
    }

    customers.delete(socketId);

    if (customers.size === 0) {
      this.customerSocketsByShipment.delete(state.shipmentId);
    }
  }

  broadcastTrackingUpdate(
    shipmentId: string,
    payload: TrackingBroadcastPayload,
  ) {
    const customers = this.customerSocketsByShipment.get(shipmentId);

    if (!customers?.size || !this.server) {
      return;
    }

    for (const socketId of customers) {
      this.server.to(socketId).emit('tracking:update', payload);
    }
  }
}
