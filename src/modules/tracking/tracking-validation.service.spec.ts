import { TrackingValidationService } from './tracking-validation.service';

describe('TrackingValidationService', () => {
  it('reuses the last good location when GPS accuracy is worse than 50 metres', () => {
    const service = new TrackingValidationService();
    const shipmentId = 'shipment-accuracy';
    const firstTimestamp = new Date('2026-04-03T10:00:00.000Z').getTime();

    service.validate(
      shipmentId,
      {
        latitude: 12.9716,
        longitude: 77.5946,
        accuracy: 10,
      },
      firstTimestamp,
    );

    const rejected = service.validate(
      shipmentId,
      {
        latitude: 13.5,
        longitude: 78.5,
        accuracy: 120,
      },
      firstTimestamp + 5_000,
    );

    expect(rejected.accepted).toBe(false);
    expect(rejected.rejectionReason).toBe('accuracy');
    expect(rejected.location.latitude).toBeCloseTo(12.9716, 4);
    expect(rejected.location.longitude).toBeCloseTo(77.5946, 4);
  });

  it('reuses the last good location when implied speed is impossible for a delivery bike', () => {
    const service = new TrackingValidationService();
    const shipmentId = 'shipment-speed';
    const firstTimestamp = new Date('2026-04-03T10:00:00.000Z').getTime();

    service.validate(
      shipmentId,
      {
        latitude: 12.9716,
        longitude: 77.5946,
        accuracy: 8,
      },
      firstTimestamp,
    );

    const rejected = service.validate(
      shipmentId,
      {
        latitude: 13.2716,
        longitude: 77.8946,
        accuracy: 8,
      },
      firstTimestamp + 60_000,
    );

    expect(rejected.accepted).toBe(false);
    expect(rejected.rejectionReason).toBe('speed');
    expect(rejected.location.latitude).toBeCloseTo(12.9716, 4);
    expect(rejected.location.longitude).toBeCloseTo(77.5946, 4);
  });
});
