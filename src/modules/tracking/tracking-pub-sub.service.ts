import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { TRACKING_CHANNEL_PREFIX } from './tracking.constants';
import type {
  TrackingPubSub,
  TrackingPubSubHandler,
  TrackingPubSubMessage,
} from './interfaces/tracking-pub-sub.interface';

const MAX_RECONNECT_DELAY_MS = 30_000;
const WARNING_THROTTLE_MS = 60_000;

/**
 * Redis-backed tracking fan-out across server instances.
 *
 * When Redis is unreachable we never disable fan-out permanently: messages are
 * dispatched to the in-process handlers (so customers connected to this
 * instance keep receiving live updates) while ioredis keeps reconnecting in the
 * background. Once both connections are ready again, Redis is used again.
 */
@Injectable()
export class TrackingPubSubService
  implements TrackingPubSub, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TrackingPubSubService.name);
  private readonly handlers = new Set<TrackingPubSubHandler>();
  private publisher?: Redis;
  private subscriber?: Redis;
  private readonly redisUrl: string;
  private publisherReady = false;
  private subscriberReady = false;
  private lastWarningAt = 0;

  constructor(private readonly configService: ConfigService) {
    this.redisUrl =
      this.configService.get<string>('REDIS_URL') ??
      process.env.REDIS_URL ??
      'redis://127.0.0.1:6379';
  }

  onModuleInit() {
    const retryStrategy = (times: number) =>
      Math.min(times * 500, MAX_RECONNECT_DELAY_MS);

    this.publisher = new Redis(this.redisUrl, {
      lazyConnect: true,
      // Fail fast while disconnected so publish() can fall back locally.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy,
    });
    this.subscriber = new Redis(this.redisUrl, {
      lazyConnect: true,
      autoResubscribe: true,
      maxRetriesPerRequest: null,
      retryStrategy,
    });

    this.publisher.on('ready', () => {
      this.publisherReady = true;
      this.logger.log(
        `Redis tracking publisher connected via ${this.redactUrl(this.redisUrl)}`,
      );
    });
    this.publisher.on('close', () => {
      this.publisherReady = false;
    });
    this.publisher.on('error', (error: unknown) => {
      this.publisherReady = this.publisher?.status === 'ready';
      this.warnThrottled('publisher', error);
    });

    this.subscriber.on('ready', () => {
      // psubscribe is idempotent; issuing it on every ready also covers the
      // case where the very first connection attempt failed.
      this.subscriber
        ?.psubscribe(`${TRACKING_CHANNEL_PREFIX}:*`)
        .then(() => {
          this.subscriberReady = true;
          this.logger.log(
            `Subscribed to Redis tracking channels via ${this.redactUrl(this.redisUrl)}`,
          );
        })
        .catch((error: unknown) => {
          this.subscriberReady = false;
          this.warnThrottled('subscriber', error);
        });
    });
    this.subscriber.on('close', () => {
      this.subscriberReady = false;
    });
    this.subscriber.on('error', (error: unknown) => {
      this.warnThrottled('subscriber', error);
    });
    this.subscriber.on('pmessage', (_pattern, _channel, rawMessage: string) => {
      this.dispatchRaw(rawMessage);
    });

    // Connection happens in the background; ioredis keeps retrying with the
    // retryStrategy above, so a failed first attempt is not fatal.
    void this.publisher.connect().catch((error: unknown) => {
      this.warnThrottled('publisher', error);
    });
    void this.subscriber.connect().catch((error: unknown) => {
      this.warnThrottled('subscriber', error);
    });
  }

  async onModuleDestroy() {
    await Promise.all([
      this.publisher?.quit().catch(() => this.publisher?.disconnect()),
      this.subscriber?.quit().catch(() => this.subscriber?.disconnect()),
    ]);
  }

  async publish(message: TrackingPubSubMessage) {
    if (this.isRedisAvailable() && this.publisher) {
      try {
        await this.publisher.publish(
          this.toChannelName(message.shipmentId),
          JSON.stringify(message),
        );
        return;
      } catch (error) {
        this.warnThrottled(`publish for shipment ${message.shipmentId}`, error);
      }
    }

    // Local in-process fan-out fallback.
    await this.dispatchMessage(message);
  }

  registerHandler(handler: TrackingPubSubHandler) {
    this.handlers.add(handler);
  }

  private isRedisAvailable() {
    return this.publisherReady && this.subscriberReady;
  }

  private dispatchRaw(rawMessage: string) {
    let message: TrackingPubSubMessage;
    try {
      message = JSON.parse(rawMessage) as TrackingPubSubMessage;
    } catch (error) {
      this.logger.warn(
        `Dropping unparseable Redis tracking message: ${this.toErrorMessage(error)}`,
      );
      return;
    }

    this.dispatchMessage(message).catch((error: unknown) => {
      this.logger.error(
        `Tracking pub/sub dispatch failed: ${this.toErrorMessage(error)}`,
      );
    });
  }

  private async dispatchMessage(message: TrackingPubSubMessage) {
    for (const handler of this.handlers) {
      try {
        await handler(message);
      } catch (error) {
        this.logger.error(
          `Tracking pub/sub handler failed for shipment ${message.shipmentId}: ${this.toErrorMessage(error)}`,
        );
      }
    }
  }

  private warnThrottled(context: string, error: unknown) {
    const now = Date.now();
    if (now - this.lastWarningAt < WARNING_THROTTLE_MS) {
      return;
    }
    this.lastWarningAt = now;
    this.logger.warn(
      `Redis tracking pub/sub ${context} unavailable at ${this.redactUrl(this.redisUrl)}; using in-process fan-out until it reconnects. ${this.toErrorMessage(error)}`,
    );
  }

  private redactUrl(url: string) {
    try {
      const parsed = new URL(url);
      if (parsed.password) {
        parsed.password = '***';
      }
      return parsed.toString();
    } catch {
      return 'configured REDIS_URL';
    }
  }

  private toChannelName(shipmentId: string) {
    return `${TRACKING_CHANNEL_PREFIX}:${shipmentId}`;
  }

  private toErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
