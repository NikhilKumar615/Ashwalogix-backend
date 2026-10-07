import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Consumer, Kafka, KafkaConfig, Producer, SASLOptions } from 'kafkajs';
import { ORDER_EVENTS_TOPIC, RIDER_LOCATION_TOPIC } from './kafka.constants';
import type {
  OrderEventHandler,
  OrderEventMessage,
  RiderLocationEvent,
  RiderLocationHandler,
  TrackingEventBus,
} from './interfaces/tracking-event-bus.interface';

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const CONSUMER_HANDLER_ATTEMPTS = 3;

type SupportedSaslMechanism = Extract<
  SASLOptions['mechanism'],
  'plain' | 'scram-sha-256' | 'scram-sha-512'
>;

@Injectable()
export class KafkaEventBusService implements TrackingEventBus, OnModuleDestroy {
  private readonly logger = new Logger(KafkaEventBusService.name);
  private readonly brokers: string[];
  private readonly kafkaClientId: string;
  private readonly kafkaSsl?: KafkaConfig['ssl'];
  private readonly kafkaSasl?: SASLOptions;
  private readonly kafka?: Kafka;
  private producer?: Producer;
  private readonly consumers: Consumer[] = [];
  private producerReady = false;
  private producerConnecting?: Promise<Producer | null>;
  private producerFailures = 0;
  private nextProducerAttemptAt = 0;
  private shuttingDown = false;
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private disabledWarningLogged = false;
  private readonly publishRetries: number;

  constructor(private readonly configService: ConfigService) {
    const serviceUri = this.resolveServiceUri();
    this.brokers = this.resolveBrokers(serviceUri);
    this.kafkaClientId =
      this.configService.get<string>('KAFKA_CLIENT_ID') ??
      process.env.KAFKA_CLIENT_ID ??
      'ashwa-logix-backend';
    this.kafkaSsl = this.resolveKafkaSsl(serviceUri);
    this.kafkaSasl = this.resolveKafkaSasl(serviceUri);
    this.publishRetries = Math.max(
      1,
      Number(this.configService.get<string>('EVENT_PUBLISH_RETRIES') ?? '3'),
    );

    if (this.brokers.length > 0) {
      const config: KafkaConfig = {
        clientId: this.kafkaClientId,
        brokers: this.brokers,
        connectionTimeout: 10_000,
        requestTimeout: 30_000,
      };

      if (this.kafkaSsl !== undefined) {
        config.ssl = this.kafkaSsl;
      }

      if (this.kafkaSasl) {
        config.sasl = this.kafkaSasl;
      }

      this.kafka = new Kafka(config);
    }
  }

  async publishRiderLocation(event: RiderLocationEvent): Promise<boolean> {
    return this.publish(RIDER_LOCATION_TOPIC, event.shipmentId, event);
  }

  async publishOrderEvent(event: OrderEventMessage): Promise<void> {
    await this.publish(ORDER_EVENTS_TOPIC, event.shipmentId, event);
  }

  async registerRiderLocationConsumer(
    groupId: string,
    handler: RiderLocationHandler,
  ) {
    await this.registerConsumer(
      RIDER_LOCATION_TOPIC,
      groupId,
      async (payload) => {
        await handler(payload as RiderLocationEvent);
      },
    );
  }

  async registerOrderEventConsumer(
    groupId: string,
    handler: OrderEventHandler,
  ) {
    await this.registerConsumer(
      ORDER_EVENTS_TOPIC,
      groupId,
      async (payload) => {
        await handler(payload as OrderEventMessage);
      },
    );
  }

  async onModuleDestroy() {
    this.shuttingDown = true;
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();

    await Promise.allSettled([
      this.producer?.disconnect(),
      ...this.consumers.map((consumer) => consumer.disconnect()),
    ]);
  }

  private async publish(
    topic: string,
    key: string,
    payload: unknown,
  ): Promise<boolean> {
    const producer = await this.getProducer();

    if (!producer) {
      return false;
    }

    for (let attempt = 1; attempt <= this.publishRetries; attempt += 1) {
      try {
        await producer.send({
          topic,
          messages: [
            {
              key,
              value: JSON.stringify(payload),
            },
          ],
        });
        return true;
      } catch (error) {
        if (attempt === this.publishRetries) {
          this.logger.error(
            `Failed to publish Kafka message to ${topic} after ${attempt} attempts: ${this.toErrorMessage(error)}`,
          );
          // Force a reconnect (with backoff) on a later publish.
          this.markProducerDown();
          return false;
        }

        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }

    return false;
  }

  private async registerConsumer(
    topic: string,
    groupId: string,
    handler: (payload: unknown) => Promise<void>,
    attempt = 0,
  ) {
    if (!this.kafka) {
      this.logDisabledWarning();
      return;
    }

    if (this.shuttingDown) {
      return;
    }

    const consumer = this.kafka.consumer({
      groupId,
      sessionTimeout: 30_000,
      rebalanceTimeout: 60_000,
      heartbeatInterval: 3_000,
    });
    this.consumers.push(consumer);

    // kafkajs restarts by itself after retriable crashes; after a
    // non-retriable crash we discard the consumer and start a fresh one.
    consumer.on(consumer.events.CRASH, (event) => {
      if (event.payload.restart === false && !this.shuttingDown) {
        this.logger.error(
          `Kafka consumer ${groupId} for topic ${topic} crashed: ${this.toErrorMessage(event.payload.error)}. Restarting with backoff.`,
        );
        void this.discardConsumer(consumer).then(() =>
          this.scheduleConsumerRetry(topic, groupId, handler, 1),
        );
      }
    });

    try {
      await consumer.connect();
      await consumer.subscribe({
        topic,
        fromBeginning: false,
      });
      await consumer.run({
        autoCommit: true,
        eachMessage: async ({ partition, message }) => {
          if (!message.value) {
            return;
          }

          const rawValue = message.value.toString();
          let payload: unknown;
          try {
            payload = JSON.parse(rawValue) as unknown;
          } catch (error) {
            this.logDeadLetter(
              topic,
              groupId,
              partition,
              message.offset,
              rawValue,
              error,
              'unparseable payload',
            );
            return;
          }

          for (
            let handlerAttempt = 1;
            handlerAttempt <= CONSUMER_HANDLER_ATTEMPTS;
            handlerAttempt += 1
          ) {
            try {
              await handler(payload);
              return;
            } catch (error) {
              if (handlerAttempt === CONSUMER_HANDLER_ATTEMPTS) {
                // Never rethrow: a poison message must not block the partition.
                this.logDeadLetter(
                  topic,
                  groupId,
                  partition,
                  message.offset,
                  rawValue,
                  error,
                  `handler failed after ${handlerAttempt} attempts`,
                );
                return;
              }

              await new Promise((resolve) =>
                setTimeout(resolve, handlerAttempt * 200),
              );
            }
          }
        },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to start Kafka consumer ${groupId} for topic ${topic} (attempt ${attempt + 1}): ${this.toErrorMessage(error)}`,
      );
      await this.discardConsumer(consumer);
      this.scheduleConsumerRetry(topic, groupId, handler, attempt + 1);
    }
  }

  private scheduleConsumerRetry(
    topic: string,
    groupId: string,
    handler: (payload: unknown) => Promise<void>,
    attempt: number,
  ) {
    if (this.shuttingDown) {
      return;
    }

    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      void this.registerConsumer(topic, groupId, handler, attempt);
    }, this.backoffMs(attempt));
    timer.unref?.();
    this.retryTimers.add(timer);
  }

  private async discardConsumer(consumer: Consumer) {
    const index = this.consumers.indexOf(consumer);
    if (index >= 0) {
      this.consumers.splice(index, 1);
    }
    await consumer.disconnect().catch(() => undefined);
  }

  private logDeadLetter(
    topic: string,
    groupId: string,
    partition: number,
    offset: string,
    rawValue: string,
    error: unknown,
    reason: string,
  ) {
    this.logger.error(
      `[DLQ] Skipping Kafka message topic=${topic} group=${groupId} partition=${partition} offset=${offset} (${reason}): ${this.toErrorMessage(error)} payload=${rawValue.slice(0, 500)}`,
    );
  }

  private async getProducer() {
    if (!this.kafka) {
      this.logDisabledWarning();
      return null;
    }

    if (this.producerReady && this.producer) {
      return this.producer;
    }

    if (this.producerConnecting) {
      return this.producerConnecting;
    }

    if (Date.now() < this.nextProducerAttemptAt) {
      return null;
    }

    this.producerConnecting = this.connectProducer();
    try {
      return await this.producerConnecting;
    } finally {
      this.producerConnecting = undefined;
    }
  }

  private async connectProducer(): Promise<Producer | null> {
    if (!this.kafka) {
      return null;
    }

    if (this.producer) {
      await this.producer.disconnect().catch(() => undefined);
    }

    const producer = this.kafka.producer();
    producer.on(producer.events.DISCONNECT, () => {
      if (this.producer === producer) {
        this.producerReady = false;
      }
    });
    this.producer = producer;

    try {
      await producer.connect();
      this.producerReady = true;
      this.producerFailures = 0;
      this.nextProducerAttemptAt = 0;
      return producer;
    } catch (error) {
      this.markProducerDown();
      this.logger.warn(
        `Failed to connect Kafka producer to ${this.brokers.join(', ')}: ${this.toErrorMessage(error)}. Next attempt in ${Math.round((this.nextProducerAttemptAt - Date.now()) / 1000)}s.`,
      );
      return null;
    }
  }

  private markProducerDown() {
    this.producerReady = false;
    this.producerFailures += 1;
    this.nextProducerAttemptAt =
      Date.now() + this.backoffMs(this.producerFailures);
  }

  private backoffMs(attempt: number) {
    const exponent = Math.max(0, Math.min(attempt, 10) - 1);
    return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** exponent);
  }

  private resolveServiceUri() {
    return (
      this.configService.get<string>('KAFKA_SERVICE_URI') ??
      process.env.KAFKA_SERVICE_URI ??
      ''
    ).trim();
  }

  private resolveBrokers(serviceUri: string) {
    const configured =
      this.configService.get<string>('KAFKA_BROKERS') ??
      process.env.KAFKA_BROKERS ??
      '';

    const brokers = configured
      .split(',')
      .map((broker) => broker.trim())
      .filter((broker) => broker.length > 0);

    if (brokers.length > 0) {
      return brokers;
    }

    if (!serviceUri) {
      return [];
    }

    try {
      const url = new URL(serviceUri);
      if (url.hostname && url.port) {
        return [`${url.hostname}:${url.port}`];
      }
    } catch {
      this.logger.warn(
        'Failed to parse KAFKA_SERVICE_URI while resolving brokers',
      );
    }

    return [];
  }

  private resolveKafkaSsl(serviceUri: string): KafkaConfig['ssl'] | undefined {
    const ca = this.resolveMultilineEnvValue('KAFKA_SSL_CA');
    const cert = this.resolveMultilineEnvValue('KAFKA_SSL_CERT');
    const key = this.resolveMultilineEnvValue('KAFKA_SSL_KEY');

    if (ca || cert || key) {
      return {
        rejectUnauthorized: true,
        ...(ca ? { ca: [ca] } : {}),
        ...(cert ? { cert } : {}),
        ...(key ? { key } : {}),
      };
    }

    const configured =
      this.configService.get<string>('KAFKA_SSL') ?? process.env.KAFKA_SSL;

    if (configured) {
      return ['true', '1', 'yes'].includes(configured.toLowerCase())
        ? true
        : undefined;
    }

    return serviceUri.length > 0 ? true : undefined;
  }

  private resolveKafkaSasl(serviceUri: string): SASLOptions | undefined {
    const mechanism = this.normalizeSaslMechanism(
      this.configService.get<string>('KAFKA_SASL_MECHANISM') ??
        process.env.KAFKA_SASL_MECHANISM,
    );
    const username =
      this.configService.get<string>('KAFKA_USERNAME') ??
      process.env.KAFKA_USERNAME;
    const password =
      this.configService.get<string>('KAFKA_PASSWORD') ??
      process.env.KAFKA_PASSWORD;

    if (mechanism && username && password) {
      return {
        mechanism,
        username,
        password,
      };
    }

    if (!serviceUri) {
      return undefined;
    }

    try {
      const url = new URL(serviceUri);
      const parsedUsername = decodeURIComponent(url.username);
      const parsedPassword = decodeURIComponent(url.password);

      if (!parsedUsername || !parsedPassword) {
        return undefined;
      }

      return {
        mechanism: mechanism ?? 'scram-sha-256',
        username: parsedUsername,
        password: parsedPassword,
      };
    } catch {
      this.logger.warn(
        'Failed to parse KAFKA_SERVICE_URI while resolving SASL credentials',
      );
      return undefined;
    }
  }

  private normalizeSaslMechanism(
    mechanism?: string | null,
  ): SupportedSaslMechanism | undefined {
    if (!mechanism) {
      return undefined;
    }

    const normalized = mechanism.trim().toLowerCase();

    if (
      normalized === 'plain' ||
      normalized === 'scram-sha-256' ||
      normalized === 'scram-sha-512'
    ) {
      return normalized as SupportedSaslMechanism;
    }

    if (normalized === 'scram_sha_256' || normalized === 'scramsha256') {
      return 'scram-sha-256';
    }

    if (normalized === 'scram_sha_512' || normalized === 'scramsha512') {
      return 'scram-sha-512';
    }

    this.logger.warn(
      `Unsupported KAFKA_SASL_MECHANISM "${mechanism}". Falling back to automatic resolution.`,
    );
    return undefined;
  }

  private resolveMultilineEnvValue(name: string) {
    const value =
      this.configService.get<string>(name) ?? process.env[name] ?? '';

    const trimmed = value.trim();

    if (!trimmed) {
      return undefined;
    }

    return trimmed.replace(/\\n/g, '\n');
  }

  private logDisabledWarning() {
    if (this.disabledWarningLogged) {
      return;
    }

    this.disabledWarningLogged = true;
    this.logger.warn(
      'Kafka event bus is disabled because KAFKA_BROKERS is not configured',
    );
  }

  private toErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
