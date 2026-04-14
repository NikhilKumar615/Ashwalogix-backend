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

@Injectable()
export class KafkaEventBusService
  implements TrackingEventBus, OnModuleDestroy
{
  private readonly logger = new Logger(KafkaEventBusService.name);
  private readonly brokers: string[];
  private readonly kafkaClientId: string;
  private readonly kafka?: Kafka;
  private producer?: Producer;
  private readonly consumers: Consumer[] = [];
  private producerReady = false;
  private producerAttempted = false;
  private disabledWarningLogged = false;

  constructor(private readonly configService: ConfigService) {
    this.brokers = this.resolveBrokers();
    this.kafkaClientId =
      this.configService.get<string>('KAFKA_CLIENT_ID') ??
      process.env.KAFKA_CLIENT_ID ??
      'ashwa-logix-backend';

    if (this.brokers.length > 0) {
      const config: KafkaConfig = {
        clientId: this.kafkaClientId,
        brokers: this.brokers,
        connectionTimeout: 10_000,
        requestTimeout: 30_000,
      };
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

  private resolveBrokers() {
    const configured =
      this.configService.get<string>('KAFKA_BROKERS') ??
      process.env.KAFKA_BROKERS ??
      '';

    return configured
      .split(',')
      .map((broker) => broker.trim())
      .filter((broker) => broker.length > 0);
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
