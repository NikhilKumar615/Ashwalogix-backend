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
import { UsePipes, ValidationPipe } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import { TrackingLocationUpdateDto } from './dto/tracking-location-update.dto';
import type { TrackingTokenPayload } from './interfaces/tracking-token-payload.interface';
import { TrackingAuthService } from './tracking-auth.service';
import { TrackingRoomService } from './tracking-room.service';
import { TrackingService } from './tracking.service';

type TrackingSocket = Socket & {
  data: {
    tracking?: TrackingTokenPayload;
  };
};

@WebSocketGateway({
  namespace: '/tracking',
  cors: {
    origin: '*',
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

      client.data.tracking = trackingToken;
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
      client.emit('tracking:error', {
        message: error instanceof Error ? error.message : 'Unauthorized',
      });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: TrackingSocket) {
    if (client.data.tracking?.role === 'rider') {
      this.trackingService.clearTrackingState(client.data.tracking.shipmentId);
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
    const trackingToken = client.data.tracking;

    if (!trackingToken) {
      throw new WsException('Socket is not authenticated');
    }

    if (trackingToken.role !== 'rider') {
      throw new WsException('Only rider clients can send location updates');
    }

    const update = await this.trackingService.processLocationUpdate(
      trackingToken,
      payload,
    );

    return {
      event: 'location:ack',
      data: update,
    };
  }

  private toRoomName(shipmentId: string) {
    return `tracking:${shipmentId}`;
  }
}
