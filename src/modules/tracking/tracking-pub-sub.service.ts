import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  TRACKING_CHANNEL_PREFIX,
} from './tracking.constants';
import type {
  TrackingPubSub,
  TrackingPubSubHandler,
  TrackingPubSubMessage,
} from './interfaces/tracking-pub-sub.interface';

@Injectable()
export class TrackingPubSubService
  implements TrackingPubSub, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TrackingPubSubService.name);
  private readonly handlers = new Set<TrackingPubSubHandler>();
  private publisher?: Redis;
  private subscriber?: Redis;
  private readonly redisUrl: string;
  private redisAvailable = false;
  private initWarningLogged = false;

  constructor(private readonly configService: ConfigService) {
    this.redisUrl =
      this.configService.get<string>('REDIS_URL') ??
      process.env.REDIS_URL ??
      'redis://127.0.0.1:6379';
  }

  async onModuleInit() {
    this.publisher = new Redis(this.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    this.subscriber = new Redis(this.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });

    this.subscriber.on('pmessage', (_pattern, _channel, rawMessage) => {
      void this.dispatchMessage(rawMessage);
    });

    try {
      await this.publisher.connect();
      await this.subscriber.connect();
      await this.subscriber.psubscribe(`${TRACKING_CHANNEL_PREFIX}:*`);
      this.redisAvailable = true;
      this.logger.log(
        `Subscribed to Redis tracking channels via ${this.redisUrl}`,
      );
    } catch (error) {
      this.redisAvailable = false;
      await Promise.all([
        this.publisher?.quit().catch(() => undefined),
        this.subscriber?.quit().catch(() => undefined),
      ]);
      this.publisher = undefined;
      this.subscriber = undefined;

      if (!this.initWarningLogged) {
        this.initWarningLogged = true;
        this.logger.warn(
          `Redis tracking pub/sub unavailable at ${this.redisUrl}. Continuing without Redis-backed tracking fanout. ${this.toErrorMessage(error)}`,
        );
      }
    }
  }

  async onModuleDestroy() {
    await Promise.all([
      this.publisher?.quit().catch(() => undefined),
      this.subscriber?.quit().catch(() => undefined),
    ]);
  }

  async publish(message: TrackingPubSubMessage) {
    if (!this.redisAvailable || !this.publisher) {
      return;
    }

    try {
      await this.publisher.publish(
        this.toChannelName(message.shipmentId),
        JSON.stringify(message),
      );
    } catch (error) {
      this.redisAvailable = false;
      this.logger.warn(
        `Redis tracking publish failed for shipment ${message.shipmentId}: ${this.toErrorMessage(error)}`,
      );
    }
  }

  registerHandler(handler: TrackingPubSubHandler) {
    this.handlers.add(handler);
  }

  private async dispatchMessage(rawMessage: string) {
    const message = JSON.parse(rawMessage) as TrackingPubSubMessage;

    for (const handler of this.handlers) {
      await handler(message);
    }
  }

  private toChannelName(shipmentId: string) {
    return `${TRACKING_CHANNEL_PREFIX}:${shipmentId}`;
  }

  private toErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
