import { Injectable } from '@nestjs/common';

@Injectable()
export class HealthService {
  getStatus() {
    return {
      service: 'ashwa-logix-backend',
      status: 'ok',
      version: 'v1',
    };
  }
}
