import { TrackingService } from './tracking.service';
import { TrackingKalmanService } from './tracking-kalman.service';
import { TrackingRoadEtaService } from './tracking-road-eta.service';
import { TrackingValidationService } from './tracking-validation.service';

describe('TrackingService', () => {
  it('clears Kalman and validation state when a rider disconnects', () => {
    const kalmanService = new TrackingKalmanService();
    const validationService = new TrackingValidationService();
    const service = new TrackingService(
      {
        shipment: {
          findUnique: jest.fn(),
        },
      } as never,
      kalmanService,
      {
        resolveEtaSeconds: jest.fn(),
      } as unknown as TrackingRoadEtaService,
      validationService,
      {
        publish: jest.fn(),
        registerHandler: jest.fn(),
      },
      {
        publishRiderLocation: jest.fn(),
        publishOrderEvent: jest.fn(),
        registerRiderLocationConsumer: jest.fn(),
        registerOrderEventConsumer: jest.fn(),
      },
    );

    kalmanService.update('shipment-disconnect', {
      latitude: 12.9716,
      longitude: 77.5946,
      accuracy: 10,
    });
    validationService.validate(
      'shipment-disconnect',
      {
        latitude: 12.9716,
        longitude: 77.5946,
        accuracy: 10,
      },
      Date.now(),
    );

    expect(kalmanService.hasState('shipment-disconnect')).toBe(true);
    expect(validationService.hasState('shipment-disconnect')).toBe(true);

    service.clearTrackingState('shipment-disconnect');

    expect(kalmanService.hasState('shipment-disconnect')).toBe(false);
    expect(validationService.hasState('shipment-disconnect')).toBe(false);
  });
});
