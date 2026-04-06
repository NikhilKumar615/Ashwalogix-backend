import { TrackingKalmanService } from './tracking-kalman.service';

describe('TrackingKalmanService', () => {
  it('keeps the first measurement as-is and smooths follow-up jitter', () => {
    const service = new TrackingKalmanService();

    const first = service.update('shipment-1', {
      latitude: 12.9716,
      longitude: 77.5946,
      accuracy: 10,
    });

    const second = service.update('shipment-1', {
      latitude: 12.9726,
      longitude: 77.5956,
      accuracy: 10,
    });

    expect(first).toEqual({
      latitude: 12.9716,
      longitude: 77.5946,
    });
    expect(second.latitude).toBeGreaterThan(first.latitude);
    expect(second.latitude).toBeLessThan(12.9726);
    expect(second.longitude).toBeGreaterThan(first.longitude);
    expect(second.longitude).toBeLessThan(77.5956);
  });
});
