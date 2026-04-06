import { TrackingEtaCacheService } from './tracking-eta-cache.service';
import { TrackingEtaService } from './tracking-eta.service';
import { TrackingRoadEtaService } from './tracking-road-eta.service';

describe('TrackingRoadEtaService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns cached ETA without calling OSRM again', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;

    const service = new TrackingRoadEtaService(
      {
        get: jest.fn().mockReturnValue('http://osrm.test'),
      } as never,
      new TrackingEtaService(),
      {
        getEtaSeconds: jest.fn().mockResolvedValue(321),
        setEtaSeconds: jest.fn(),
      } as unknown as TrackingEtaCacheService,
    );

    const etaSeconds = await service.resolveEtaSeconds(
      'shipment-cache',
      { latitude: 12.9716, longitude: 77.5946 },
      { latitude: 12.9816, longitude: 77.6046 },
    );

    expect(etaSeconds).toBe(321);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses OSRM duration and caches it for 10 seconds when available', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        code: 'Ok',
        routes: [{ duration: 412.6 }],
      }),
    });
    global.fetch = fetchMock as typeof fetch;

    const cache = {
      getEtaSeconds: jest.fn().mockResolvedValue(null),
      setEtaSeconds: jest.fn().mockResolvedValue(undefined),
    } as unknown as TrackingEtaCacheService;

    const service = new TrackingRoadEtaService(
      {
        get: jest.fn().mockReturnValue('http://osrm.test'),
      } as never,
      new TrackingEtaService(),
      cache,
    );

    const etaSeconds = await service.resolveEtaSeconds(
      'shipment-osrm',
      { latitude: 12.9716, longitude: 77.5946 },
      { latitude: 12.9816, longitude: 77.6046 },
    );

    expect(etaSeconds).toBe(413);
    expect(cache.setEtaSeconds).toHaveBeenCalledWith('shipment-osrm', 413);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to Haversine ETA when OSRM is unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as typeof fetch;

    const fallbackEtaService = new TrackingEtaService();
    const fallbackSpy = jest.spyOn(fallbackEtaService, 'calculateEtaSeconds');
    const cache = {
      getEtaSeconds: jest.fn().mockResolvedValue(null),
      setEtaSeconds: jest.fn(),
    } as unknown as TrackingEtaCacheService;

    const service = new TrackingRoadEtaService(
      {
        get: jest.fn().mockReturnValue('http://osrm.test'),
      } as never,
      fallbackEtaService,
      cache,
    );

    const etaSeconds = await service.resolveEtaSeconds(
      'shipment-fallback',
      { latitude: 12.9716, longitude: 77.5946 },
      { latitude: 12.9816, longitude: 77.6046 },
    );

    expect(etaSeconds).toBeGreaterThan(0);
    expect(fallbackSpy).toHaveBeenCalled();
    expect(cache.setEtaSeconds).not.toHaveBeenCalled();
  });
});
