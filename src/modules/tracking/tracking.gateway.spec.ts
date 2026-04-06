import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { TRACKING_PUB_SUB } from './tracking.constants';
import type { TrackingPubSub, TrackingPubSubHandler, TrackingPubSubMessage } from './interfaces/tracking-pub-sub.interface';
import { TrackingModule } from './tracking.module';
import { TrackingPubSubService } from './tracking-pub-sub.service';

describe('TrackingGateway', () => {
  let riderApp: INestApplication;
  let customerApp: INestApplication;
  let riderJwtService: JwtService;
  let riderClient: ClientSocket;
  let customerClient: ClientSocket;

  const shipmentId = 'shipment-123';
  const organizationId = 'org-123';
  const destination = {
    latitude: 12.9816,
    longitude: 77.6046,
  };
  const pubSubHandlers = new Set<TrackingPubSubHandler>();
  const fakePubSub: TrackingPubSub = {
    async publish(message: TrackingPubSubMessage) {
      for (const handler of pubSubHandlers) {
        await handler(message);
      }
    },
    registerHandler(handler: TrackingPubSubHandler) {
      pubSubHandlers.add(handler);
    },
  };

  beforeAll(async () => {
    const createApp = async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            load: [
              () => ({
                JWT_SECRET: 'test-secret',
              }),
            ],
          }),
          TrackingModule,
        ],
      })
        .overrideProvider(PrismaService)
        .useValue({
          shipment: {
            findUnique: jest
              .fn()
              .mockImplementation(({ where }: { where: { id: string } }) => {
                if (where.id !== shipmentId) {
                  return null;
                }

                return Promise.resolve({
                  id: shipmentId,
                  organizationId,
                  currentDriverId: 'driver-123',
                  currentTrackingSessionId: 'session-123',
                });
              }),
          },
        })
        .overrideProvider(ShipmentsService)
        .useValue({
          startTrackingSession: jest.fn(),
          addTrackingPoint: jest.fn().mockResolvedValue(undefined),
        })
        .overrideProvider(TrackingPubSubService)
        .useValue(fakePubSub)
        .overrideProvider(TRACKING_PUB_SUB)
        .useValue(fakePubSub)
        .compile();

      const app = moduleRef.createNestApplication();
      await app.listen(0);

      return {
        app,
        jwtService: moduleRef.get(JwtService),
      };
    };

    const riderSide = await createApp();
    riderApp = riderSide.app;
    riderJwtService = riderSide.jwtService;

    const customerSide = await createApp();
    customerApp = customerSide.app;
  });

  afterAll(async () => {
    riderClient?.close();
    customerClient?.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await riderApp?.close();
    await customerApp?.close();
  });

  it('broadcasts rider updates to customers connected to a different server instance', async () => {
    const riderPort = (riderApp.getHttpServer().address() as { port: number }).port;
    const customerPort = (customerApp.getHttpServer().address() as { port: number }).port;
    const riderBaseUrl = `http://127.0.0.1:${riderPort}/tracking`;
    const customerBaseUrl = `http://127.0.0.1:${customerPort}/tracking`;

    const riderToken = await riderJwtService.signAsync({
      sub: 'user-rider-1',
      shipmentId,
      organizationId,
      role: 'rider',
      destination,
    });
    const customerToken = await riderJwtService.signAsync({
      sub: 'user-customer-1',
      shipmentId,
      organizationId,
      role: 'customer',
      destination,
    });

    await new Promise<void>((resolve, reject) => {
      let readyCount = 0;
      const onReady = () => {
        readyCount += 1;
        if (readyCount === 2) {
          resolve();
        }
      };

      riderClient = createClient(riderBaseUrl, {
        auth: { token: riderToken },
        transports: ['websocket'],
      });
      customerClient = createClient(customerBaseUrl, {
        auth: { token: customerToken },
        transports: ['websocket'],
      });

      riderClient.on('connect_error', reject);
      customerClient.on('connect_error', reject);
      riderClient.on('tracking:ready', onReady);
      customerClient.on('tracking:ready', onReady);
    });

    const update = await new Promise<{
      latitude: number;
      longitude: number;
      etaSeconds: number;
      timestamp: string;
    }>((resolve, reject) => {
      customerClient.once('tracking:update', resolve);
      riderClient.emit(
        'location:update',
        {
          latitude: 12.9716,
          longitude: 77.5946,
          accuracy: 10,
        },
        (response: unknown) => {
          if (!response) {
            reject(new Error('Missing rider acknowledgement'));
          }
        },
      );

      setTimeout(() => reject(new Error('Timed out waiting for tracking update')), 3000);
    });

    expect(update.latitude).toBeCloseTo(12.9716, 4);
    expect(update.longitude).toBeCloseTo(77.5946, 4);
    expect(update.etaSeconds).toBeGreaterThan(0);
    expect(new Date(update.timestamp).toString()).not.toBe('Invalid Date');
  });
});
