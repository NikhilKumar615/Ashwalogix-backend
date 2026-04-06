import { TrackingDbSinkConsumerService } from './tracking-db-sink-consumer.service';

describe('TrackingDbSinkConsumerService', () => {
  it('registers a rider.location consumer and persists incoming events', async () => {
    let handler:
      | ((event: {
          shipmentId: string;
          organizationId: string;
          location: {
            latitude: number;
            longitude: number;
            accuracy?: number;
          };
        }) => Promise<void>)
      | undefined;

    const shipmentsService = {
      startTrackingSession: jest.fn(),
      addTrackingPoint: jest.fn().mockResolvedValue(undefined),
    };

    const service = new TrackingDbSinkConsumerService(
      {
        registerRiderLocationConsumer: jest.fn().mockImplementation(
          async (_groupId: string, incomingHandler: typeof handler) => {
            handler = incomingHandler;
          },
        ),
      } as never,
      {
        shipment: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'shipment-1',
            organizationId: 'org-1',
            currentDriverId: 'driver-1',
            currentTrackingSessionId: 'session-1',
          }),
        },
      } as never,
      shipmentsService as never,
    );

    await service.onModuleInit();
    await handler?.({
      shipmentId: 'shipment-1',
      organizationId: 'org-1',
      location: {
        latitude: 12.9716,
        longitude: 77.5946,
        accuracy: 10,
      },
    });

    expect(handler).toBeDefined();
    expect(shipmentsService.addTrackingPoint).toHaveBeenCalled();
  });
});
