import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  OnGatewayInit,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import {
  HttpException,
  Logger,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import { TrackingLocationUpdateDto } from './dto/tracking-location-update.dto';
import type { TrackingTokenPayload } from './interfaces/tracking-token-payload.interface';
import { TrackingAuthService } from './tracking-auth.service';
import { TrackingRoomService } from './tracking-room.service';
import { TrackingService } from './tracking.service';
import { allowedOrigins } from '../../shared/config/runtime-security';

type TrackingSocket = Socket & {
  data: {
    tracking?: TrackingTokenPayload;
  };
};

@WebSocketGateway({
  namespace: '/tracking',
  cors: {
    origin: allowedOrigins(),
    credentials: true,
  },
})
export class TrackingGateway
  implements
    OnGatewayInit<Server>,
    OnGatewayConnection<TrackingSocket>,
    OnGatewayDisconnect<TrackingSocket>
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(TrackingGateway.name);
  /** Live rider sockets per shipment, so one disconnect doesn't wipe shared state. */
  private readonly riderSocketsByShipment = new Map<string, Set<string>>();

  constructor(
    private readonly trackingAuthService: TrackingAuthService,
    private readonly trackingRoomService: TrackingRoomService,
    private readonly trackingService: TrackingService,
  ) {}

  afterInit(server: Server) {
    this.trackingRoomService.attachServer(server);
  }

  async handleConnection(client: TrackingSocket) {
    try {
      const trackingToken = await this.trackingAuthService.authenticate(client);
      await this.trackingService.assertTrackingAccess(trackingToken);

      this.trackingData(client).tracking = trackingToken;
      if (trackingToken.role === 'rider') {
        const riders =
          this.riderSocketsByShipment.get(trackingToken.shipmentId) ??
          new Set<string>();
        riders.add(client.id);
        this.riderSocketsByShipment.set(trackingToken.shipmentId, riders);
      }
      await client.join(this.toRoomName(trackingToken.shipmentId));
      this.trackingRoomService.registerSocket(
        client.id,
        trackingToken.shipmentId,
        trackingToken.role,
      );

      client.emit('tracking:ready', {
        shipmentId: trackingToken.shipmentId,
        role: trackingToken.role,
      });
    } catch (error) {
      this.logger.warn(
        `Tracking socket ${client.id} rejected: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      // Never leak internal error details (JWT/DB messages) to the client.
      client.emit('tracking:error', {
        message: 'Unauthorized',
      });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: TrackingSocket) {
    const tracking = this.trackingData(client).tracking;
    if (tracking?.role === 'rider') {
      const riders = this.riderSocketsByShipment.get(tracking.shipmentId);
      riders?.delete(client.id);

      // Only clear smoothing/validation state when the last live rider socket
      // for this shipment goes away.
      if (!riders || riders.size === 0) {
        this.riderSocketsByShipment.delete(tracking.shipmentId);
        this.trackingService.clearTrackingState(tracking.shipmentId);
      }
    }

    this.trackingRoomService.unregisterSocket(client.id);
  }

  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  )
  @SubscribeMessage('location:update')
  async handleLocationUpdate(
    @ConnectedSocket() client: TrackingSocket,
    @MessageBody() payload: TrackingLocationUpdateDto,
  ) {
    const trackingToken = this.trackingData(client).tracking;

    if (!trackingToken) {
      throw new WsException('Socket is not authenticated');
    }

    if (trackingToken.role !== 'rider') {
      throw new WsException('Only rider clients can send location updates');
    }

    let update: Awaited<ReturnType<TrackingService['processLocationUpdate']>>;
    try {
      update = await this.trackingService.processLocationUpdate(
        trackingToken,
        payload,
      );
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500) {
        // 4xx messages are authored by us and safe to show.
        throw new WsException(error.message);
      }
      this.logger.error(
        `Tracking location update failed for shipment ${trackingToken.shipmentId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      throw new WsException('Unable to process location update');
    }

    return {
      event: 'location:ack',
      data: update,
    };
  }

  private trackingData(client: TrackingSocket) {
    return client.data as { tracking?: TrackingTokenPayload };
  }

  private toRoomName(shipmentId: string) {
    return `tracking:${shipmentId}`;
  }
}
