import { HealthService } from './health.service';

describe('HealthService', () => {
  it('returns the backend status payload', () => {
    const service = new HealthService();

    expect(service.getStatus()).toEqual({
      service: 'ashwa-logix-backend',
      status: 'ok',
      version: 'v1',
    });
  });
});
