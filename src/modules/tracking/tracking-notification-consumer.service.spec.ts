import { TrackingNotificationConsumerService } from './tracking-notification-consumer.service';

describe('TrackingNotificationConsumerService', () => {
  it('registers an order.events consumer', async () => {
    let handler:
      | ((event: { shipmentId: string; eventType: string }) => Promise<void>)
      | undefined;

    const service = new TrackingNotificationConsumerService({
      registerOrderEventConsumer: jest.fn().mockImplementation(
        async (_groupId: string, incomingHandler: typeof handler) => {
          handler = incomingHandler;
        },
      ),
    } as never);

    await service.onModuleInit();
    await handler?.({
      shipmentId: 'shipment-1',
      eventType: 'shipment_delivered',
    });

    expect(handler).toBeDefined();
  });
});
