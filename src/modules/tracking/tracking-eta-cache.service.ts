import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

const TRACKING_ETA_CACHE_PREFIX = 'tracking:eta';
const TRACKING_ETA_CACHE_TTL_SECONDS = 10;

@Injectable()
export class TrackingEtaCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(TrackingEtaCacheService.name);
  private readonly redisUrl: string;
  private redisClient?: Redis;
  private connectionAttempted = false;
  private connectionAvailable = false;
  private connectionWarningLogged = false;

  constructor(private readonly configService: ConfigService) {
    this.redisUrl =
      this.configService.get<string>('REDIS_URL') ??
      process.env.REDIS_URL ??
      'redis://127.0.0.1:6379';
  }

  async getEtaSeconds(shipmentId: string) {
    const client = await this.getClient();

    if (!client) {
      return null;
    }

    try {
      const cachedValue = await client.get(this.toCacheKey(shipmentId));

      if (!cachedValue) {
        return null;
      }

      const parsed = Number(cachedValue);
      return Number.isFinite(parsed) ? parsed : null;
    } catch (error) {
      this.logger.warn(
        `Unable to read cached ETA for shipment ${shipmentId}: ${this.toErrorMessage(error)}`,
      );
      return null;
    }
  }

  async setEtaSeconds(shipmentId: string, etaSeconds: number) {
    const client = await this.getClient();

    if (!client) {
      return;
    }

    try {
      await client.set(
        this.toCacheKey(shipmentId),
        String(etaSeconds),
        'EX',
        TRACKING_ETA_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        `Unable to cache ETA for shipment ${shipmentId}: ${this.toErrorMessage(error)}`,
      );
    }
  }

  async onModuleDestroy() {
    await this.redisClient?.quit();
  }

  private async getClient() {
    if (this.connectionAvailable && this.redisClient) {
      return this.redisClient;
    }

    if (this.connectionAttempted) {
      return null;
    }

    this.connectionAttempted = true;
    this.redisClient = new Redis(this.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });

    try {
      await this.redisClient.connect();
      this.connectionAvailable = true;
      return this.redisClient;
    } catch (error) {
      if (!this.connectionWarningLogged) {
        this.connectionWarningLogged = true;
        this.logger.warn(
          `ETA Redis cache unavailable at ${this.redisUrl}: ${this.toErrorMessage(error)}`,
        );
      }
      await this.redisClient.quit().catch(() => undefined);
      this.redisClient = undefined;
      return null;
    }
  }

  private toCacheKey(shipmentId: string) {
    return `${TRACKING_ETA_CACHE_PREFIX}:${shipmentId}`;
  }

  private toErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
