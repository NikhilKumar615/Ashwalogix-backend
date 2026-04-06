import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackingEtaCacheService } from './tracking-eta-cache.service';
import { TrackingEtaService } from './tracking-eta.service';

type Coordinate = {
  latitude: number;
  longitude: number;
};

type OsrmRouteResponse = {
  code?: string;
  routes?: Array<{
    duration?: number;
  }>;
};

@Injectable()
export class TrackingRoadEtaService {
  private readonly logger = new Logger(TrackingRoadEtaService.name);
  private readonly osrmBaseUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly trackingEtaService: TrackingEtaService,
    private readonly trackingEtaCacheService: TrackingEtaCacheService,
  ) {
    this.osrmBaseUrl =
      this.configService.get<string>('OSRM_BASE_URL') ??
      process.env.OSRM_BASE_URL ??
      'http://router.project-osrm.org';
  }

  async resolveEtaSeconds(
    shipmentId: string,
    origin: Coordinate,
    destination: Coordinate,
  ) {
    const cachedEta = await this.trackingEtaCacheService.getEtaSeconds(shipmentId);

    if (cachedEta !== null) {
      return cachedEta;
    }

    try {
      const etaSeconds = await this.fetchRoadEtaSeconds(origin, destination);
      await this.trackingEtaCacheService.setEtaSeconds(shipmentId, etaSeconds);
      return etaSeconds;
    } catch (error) {
      this.logger.warn(
        `OSRM ETA lookup failed for shipment ${shipmentId}; using Haversine fallback: ${this.toErrorMessage(error)}`,
      );
      return this.trackingEtaService.calculateEtaSeconds(origin, destination);
    }
  }

  private async fetchRoadEtaSeconds(origin: Coordinate, destination: Coordinate) {
    const url = new URL(
      `/route/v1/driving/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`,
      this.osrmBaseUrl,
    );
    url.searchParams.set('overview', 'false');

    const response = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      throw new Error(`OSRM returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as OsrmRouteResponse;
    const durationSeconds = payload.routes?.[0]?.duration;

    if (payload.code !== 'Ok' || typeof durationSeconds !== 'number') {
      throw new Error(`OSRM returned invalid route payload with code ${payload.code ?? 'unknown'}`);
    }

    return Math.max(Math.round(durationSeconds), 0);
  }

  private toErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
