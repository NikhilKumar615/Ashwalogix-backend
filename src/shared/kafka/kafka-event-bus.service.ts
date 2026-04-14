import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Consumer,
  Kafka,
  KafkaConfig,
  Producer,
  SASLOptions,
} from 'kafkajs';
import {
  ORDER_EVENTS_TOPIC,
  RIDER_LOCATION_TOPIC,
} from './kafka.constants';
import type {
  OrderEventHandler,
  OrderEventMessage,
  RiderLocationEvent,
  RiderLocationHandler,
  TrackingEventBus,
} from './interfaces/tracking-event-bus.interface';

type SupportedSaslMechanism = Extract<
  SASLOptions['mechanism'],
  'plain' | 'scram-sha-256' | 'scram-sha-512'
>;

@Injectable()
export class KafkaEventBusService
  implements TrackingEventBus, OnModuleDestroy
{
  private readonly logger = new Logger(KafkaEventBusService.name);
  private readonly brokers: string[];
  private readonly kafkaClientId: string;
  private readonly kafkaSsl?: KafkaConfig['ssl'];
  private readonly kafkaSasl?: SASLOptions;
  private readonly kafka?: Kafka;
  private producer?: Producer;
  private readonly consumers: Consumer[] = [];
  private producerReady = false;
  private producerAttempted = false;
  private disabledWarningLogged = false;

  constructor(private readonly configService: ConfigService) {
    const serviceUri = this.resolveServiceUri();
    this.brokers = this.resolveBrokers(serviceUri);
    this.kafkaClientId =
      this.configService.get<string>('KAFKA_CLIENT_ID') ??
      process.env.KAFKA_CLIENT_ID ??
      'ashwa-logix-backend';
    this.kafkaSsl = this.resolveKafkaSsl(serviceUri);
    this.kafkaSasl = this.resolveKafkaSasl(serviceUri);

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

  async publishRiderLocation(event: RiderLocationEvent) {
    await this.publish(RIDER_LOCATION_TOPIC, event.shipmentId, event);
  }

  async publishOrderEvent(event: OrderEventMessage) {
    await this.publish(ORDER_EVENTS_TOPIC, event.shipmentId, event);
  }

  async registerRiderLocationConsumer(
    groupId: string,
    handler: RiderLocationHandler,
  ) {
    await this.registerConsumer(RIDER_LOCATION_TOPIC, groupId, async (payload) => {
      await handler(payload as RiderLocationEvent);
    });
  }

  async registerOrderEventConsumer(
    groupId: string,
    handler: OrderEventHandler,
  ) {
    await this.registerConsumer(ORDER_EVENTS_TOPIC, groupId, async (payload) => {
      await handler(payload as OrderEventMessage);
    });
  }

  async onModuleDestroy() {
    await Promise.allSettled([
      this.producer?.disconnect(),
      ...this.consumers.map((consumer) => consumer.disconnect()),
    ]);
  }

  private async publish(topic: string, key: string, payload: unknown) {
    const producer = await this.getProducer();

    if (!producer) {
      return;
    }

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
    } catch (error) {
      this.logger.warn(
        `Failed to publish Kafka message to ${topic}: ${this.toErrorMessage(error)}`,
      );
    }
  }

  private async registerConsumer(
    topic: string,
    groupId: string,
    handler: (payload: unknown) => Promise<void>,
  ) {
    if (!this.kafka) {
      this.logDisabledWarning();
      return;
    }

    const consumer = this.kafka.consumer({
      groupId,
      sessionTimeout: 30_000,
      rebalanceTimeout: 60_000,
      heartbeatInterval: 3_000,
    });
    this.consumers.push(consumer);

    try {
      await consumer.connect();
      await consumer.subscribe({
        topic,
        fromBeginning: false,
      });
      await consumer.run({
        autoCommit: true,
        eachMessage: async ({ message }) => {
          if (!message.value) {
            return;
          }

          const payload = JSON.parse(message.value.toString()) as unknown;
          await handler(payload);
        },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to start Kafka consumer ${groupId} for topic ${topic}: ${this.toErrorMessage(error)}`,
      );
    }
  }

  private async getProducer() {
    if (!this.kafka) {
      this.logDisabledWarning();
      return null;
    }

    if (this.producerReady && this.producer) {
      return this.producer;
    }

    if (this.producerAttempted) {
      return null;
    }

    this.producerAttempted = true;
    this.producer = this.kafka.producer();

    try {
      await this.producer.connect();
      this.producerReady = true;
      return this.producer;
    } catch (error) {
      this.logger.warn(
        `Failed to connect Kafka producer to ${this.brokers.join(', ')}: ${this.toErrorMessage(error)}`,
      );
      return null;
    }
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
      this.configService.get<string>('KAFKA_SSL') ??
      process.env.KAFKA_SSL;

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
