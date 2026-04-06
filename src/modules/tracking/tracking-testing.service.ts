import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { TRACKING_EVENT_BUS } from '../../shared/kafka/kafka.constants';
import type { TrackingEventBus } from '../../shared/kafka/interfaces/tracking-event-bus.interface';
import { CreateTrackingTestTokenDto } from './dto/create-tracking-test-token.dto';
import { PublishTestOrderEventDto } from './dto/publish-test-order-event.dto';

@Injectable()
export class TrackingTestingService {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(TRACKING_EVENT_BUS)
    private readonly trackingEventBus: TrackingEventBus,
  ) {}

  async createToken(input: CreateTrackingTestTokenDto) {
    const token = await this.jwtService.signAsync({
      sub: input.subject ?? `${input.role}-swagger-tester`,
      shipmentId: input.shipmentId,
      organizationId: input.organizationId,
      role: input.role,
      destination: {
        latitude: input.destinationLatitude,
        longitude: input.destinationLongitude,
      },
    });

    return {
      token,
      namespace: '/tracking',
      connectEvent: 'tracking:ready',
      riderPublishEvent: 'location:update',
      customerReceiveEvent: 'tracking:update',
      etaMode: 'OSRM road ETA with 10-second Redis cache and Haversine fallback',
      sampleLocationPayload: {
        latitude: 12.9716,
        longitude: 77.5946,
        accuracy: 10,
        speed: 8.5,
        heading: 120,
        timestamp: new Date().toISOString(),
      },
    };
  }

  getSocketContract() {
    return {
      namespace: '/tracking',
      authentication: {
        type: 'JWT',
        socketIoAuthField: 'token',
        headerFallback: 'Authorization: Bearer <token>',
      },
      roles: {
        rider: {
          canSend: ['location:update'],
          receives: ['tracking:ready'],
        },
        customer: {
          canSend: [],
          receives: ['tracking:ready', 'tracking:update'],
        },
      },
      events: {
        'location:update': {
          direction: 'rider -> server',
          payload: {
            latitude: 'number',
            longitude: 'number',
            accuracy: 'number?',
            speed: 'number?',
            heading: 'number?',
            timestamp: 'ISO-8601 string?',
          },
        },
        'tracking:update': {
          direction: 'server -> customer',
          payload: {
            shipmentId: 'string',
            latitude: 'number',
            longitude: 'number',
            etaSeconds: 'number',
            timestamp: 'ISO-8601 string',
          },
          notes: [
            'ETA is road-based via OSRM when available',
            'ETA result is cached in Redis for 10 seconds per shipment',
            'If OSRM is unavailable, the server falls back to straight-line Haversine ETA',
          ],
        },
      },
    };
  }

  getKafkaContract() {
    return {
      topics: {
        riderLocation: {
          name: 'rider.location',
          producedBy: 'WebSocket tracking server',
          consumedBy: ['ETA engine', 'database sink'],
        },
        orderEvents: {
          name: 'order.events',
          producedBy: 'shipment/order flows',
          consumedBy: ['notification service'],
        },
      },
      replayBehaviour:
        'Kafka consumer groups replay missed events after restart from committed offsets',
    };
  }

  async publishTestOrderEvent(input: PublishTestOrderEventDto) {
    const event = {
      eventId: randomUUID(),
      shipmentId: input.shipmentId,
      organizationId: input.organizationId,
      eventType: input.eventType,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      notes: input.notes ?? null,
      eventTime: new Date().toISOString(),
      metadata: {
        source: 'swagger-test',
      },
    };

    await this.trackingEventBus.publishOrderEvent(event);

    return {
      published: true,
      topic: 'order.events',
      event,
    };
  }
}
