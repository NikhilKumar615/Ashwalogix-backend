import { TrackingDbSinkConsumerService } from './tracking-db-sink-consumer.service';
import { TrackingPersistenceService } from './tracking-persistence.service';

describe('TrackingDbSinkConsumerService', () => {
  type Handler = (event: {
    shipmentId: string;
    organizationId: string;
    timestamp?: string;
    location: {
      latitude: number;
      longitude: number;
      accuracy?: number;
    };
  }) => Promise<void>;

  const buildService = (status: string) => {
    let handler: Handler | undefined;

    const shipmentsService = {
      startTrackingSession: jest.fn().mockResolvedValue({ id: 'session-2' }),
      addTrackingPoint: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      shipment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'shipment-1',
          organizationId: 'org-1',
          status,
          currentDriverId: 'driver-1',
          currentTrackingSessionId: 'session-1',
        }),
      },
      trackingSession: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'session-1', status: 'ACTIVE' }),
      },
      trackingPoint: {
        create: jest.fn().mockResolvedValue(undefined),
      },
    };

    const persistence = new TrackingPersistenceService(
      prisma as never,
      shipmentsService as never,
    );
    const service = new TrackingDbSinkConsumerService(
      {
        registerRiderLocationConsumer: jest
          .fn()
          .mockImplementation((_groupId: string, incomingHandler: Handler) => {
            handler = incomingHandler;
            return Promise.resolve();
          }),
      } as never,
      persistence,
    );

    return {
      service,
      prisma,
      shipmentsService,
      getHandler: () => handler,
    };
  };

  it('registers a rider.location consumer and persists incoming events', async () => {
    const { service, prisma, getHandler } = buildService('IN_TRANSIT');

    await service.onModuleInit();
    const timestamp = '2026-04-03T10:00:00.000Z';
    await getHandler()?.({
      shipmentId: 'shipment-1',
      organizationId: 'org-1',
      timestamp,
      location: {
        latitude: 12.9716,
        longitude: 77.5946,
        accuracy: 10,
      },
    });

    expect(getHandler()).toBeDefined();
    const [createArgs] = prisma.trackingPoint.create.mock.calls[0] as [
      { data: { trackingSessionId: string; recordedAt: Date } },
    ];
    expect(createArgs.data.trackingSessionId).toBe('session-1');
    expect(createArgs.data.recordedAt).toEqual(new Date(timestamp));
  });

  it('does not persist or open a session once the shipment is delivered', async () => {
    const { service, prisma, shipmentsService, getHandler } =
      buildService('DELIVERED');

    await service.onModuleInit();
    await getHandler()?.({
      shipmentId: 'shipment-1',
      organizationId: 'org-1',
      location: { latitude: 12.9716, longitude: 77.5946 },
    });

    expect(prisma.trackingPoint.create).not.toHaveBeenCalled();
    expect(shipmentsService.startTrackingSession).not.toHaveBeenCalled();
  });
});
