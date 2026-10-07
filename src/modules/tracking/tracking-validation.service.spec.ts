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

  it('does not refresh the last good timestamp on rejection and recovers after a gap', () => {
    const service = new TrackingValidationService();
    const shipmentId = 'shipment-recovery';
    const t0 = new Date('2026-04-03T10:00:00.000Z').getTime();

    service.validate(
      shipmentId,
      { latitude: 12.9716, longitude: 77.5946, accuracy: 8 },
      t0,
    );

    // ~45 km away after 60s -> impossible, rejected.
    const far = { latitude: 13.2716, longitude: 77.8946, accuracy: 8 };
    expect(service.validate(shipmentId, far, t0 + 60_000).accepted).toBe(false);
    expect(service.validate(shipmentId, far, t0 + 90_000).accepted).toBe(false);

    // After the recovery gap (measured from the last *accepted* point) it is accepted.
    const recovered = service.validate(shipmentId, far, t0 + 3 * 60_000);
    expect(recovered.accepted).toBe(true);
    expect(recovered.recovered).toBe(true);
  });

  it('accepts highway speeds below 120 km/h', () => {
    const service = new TrackingValidationService();
    const shipmentId = 'shipment-highway';
    const t0 = new Date('2026-04-03T10:00:00.000Z').getTime();

    service.validate(
      shipmentId,
      { latitude: 12.9716, longitude: 77.5946, accuracy: 8 },
      t0,
    );
    // ~1.67 km north in 60s = ~100 km/h
    const result = service.validate(
      shipmentId,
      { latitude: 12.9866, longitude: 77.5946, accuracy: 8 },
      t0 + 60_000,
    );
    expect(result.accepted).toBe(true);
  });
});
