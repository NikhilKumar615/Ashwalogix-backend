import {
  OnGatewayConnection,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import type { Namespace, Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { DriverRealtimeService } from './driver-realtime.service';
import { allowedOrigins } from '../../shared/config/runtime-security';

type DriverSocket = Socket & {
  data: {
    driverId?: string;
  };
};

@WebSocketGateway({
  namespace: '/driver-sync',
  cors: { origin: allowedOrigins(), credentials: true },
})
export class DriverRealtimeGateway
  implements OnGatewayInit<Server | Namespace>, OnGatewayConnection<DriverSocket>, OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;
  private redisPublisher?: Redis;
  private redisSubscriber?: Redis;
  private readonly logger = new Logger(DriverRealtimeGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly driverRealtimeService: DriverRealtimeService,
  ) {}

  afterInit(server: Server | Namespace) {
    const redisUrl = process.env.REDIS_URL?.trim();
    if (redisUrl) {
      // With a namespaced gateway Nest passes the Namespace, which has no
      // adapter() method. The adapter must be set on the root Server; it then
      // re-initialises existing namespaces, including /driver-sync.
      const rootServer = 'server' in server ? server.server : server;
      try {
        this.redisPublisher = new Redis(redisUrl, { maxRetriesPerRequest: null });
        this.redisSubscriber = this.redisPublisher.duplicate();
        rootServer.adapter(
          createAdapter(this.redisPublisher, this.redisSubscriber),
        );
      } catch (error) {
        // Fall back to the in-memory adapter (single instance) rather than
        // crashing the whole API at startup.
        this.logger.error(
          `Redis adapter for driver sync unavailable: ${(error as Error).message}`,
        );
      }
    }
    this.driverRealtimeService.attachServer(server as Server);
  }

  async onModuleDestroy() {
    await Promise.allSettled([
      this.redisPublisher?.quit(),
      this.redisSubscriber?.quit(),
    ]);
  }

  async handleConnection(client: DriverSocket) {
    try {
      const token = this.extractToken(client);
      if (!token) {
        throw new Error('Missing access token');
      }

      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      if (payload.typ !== undefined && payload.typ !== 'access') {
        throw new Error('Invalid token type');
      }

      const driver = await this.prisma.driver.findFirst({
        where: { userId: payload.sub },
        select: { id: true, organizationId: true },
      });
      if (!driver) {
        throw new Error('Driver access is not available');
      }

      // Re-check membership and organization status in the DB: the JWT may
      // outlive a removed membership or a suspended organization.
      const membership = await this.prisma.organizationUser.findFirst({
        where: {
          userId: payload.sub,
          organizationId: driver.organizationId,
          status: 'ACTIVE',
          organization: { status: 'ACTIVE' },
          user: { status: 'ACTIVE' },
        },
        select: { id: true },
      });
      if (!membership) {
        throw new Error('Driver access is not available');
      }

      client.data.driverId = driver.id;
      await client.join(`driver:${driver.id}`);
      client.emit('driver-sync:ready');
    } catch {
      // Do not expose JWT or database details to the mobile app.
      client.emit('driver-sync:error', { message: 'Unable to start live updates.' });
      client.disconnect(true);
    }
  }

  private extractToken(client: DriverSocket) {
    const authToken = client.handshake.auth?.token;
    if (typeof authToken === 'string' && authToken) {
      return authToken;
    }

    const authorization = client.handshake.headers.authorization;
    if (!authorization) {
      return null;
    }

    const [scheme, token] = authorization.split(' ');
    return scheme?.toLowerCase() === 'bearer' && token ? token : null;
  }
}
