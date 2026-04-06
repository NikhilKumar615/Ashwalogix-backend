import { TrackingEtaEngineConsumerService } from './tracking-eta-engine-consumer.service';

describe('TrackingEtaEngineConsumerService', () => {
  it('registers a rider.location consumer and recalculates ETA', async () => {
    let handler:
      | ((event: {
          shipmentId: string;
          location: { latitude: number; longitude: number };
          destination: { latitude: number; longitude: number };
        }) => Promise<void>)
      | undefined;

    const roadEtaService = {
      resolveEtaSeconds: jest.fn().mockResolvedValue(120),
    };

    const service = new TrackingEtaEngineConsumerService(
      {
        registerRiderLocationConsumer: jest.fn().mockImplementation(
          async (_groupId: string, incomingHandler: typeof handler) => {
            handler = incomingHandler;
          },
        ),
      } as never,
      roadEtaService as never,
    );

    await service.onModuleInit();
    await handler?.({
      shipmentId: 'shipment-1',
      location: { latitude: 12.9716, longitude: 77.5946 },
      destination: { latitude: 12.9816, longitude: 77.6046 },
    });

    expect(handler).toBeDefined();
    expect(roadEtaService.resolveEtaSeconds).toHaveBeenCalled();
  });
});
