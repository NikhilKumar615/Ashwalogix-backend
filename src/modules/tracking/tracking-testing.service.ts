import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OrganizationRole } from '@prisma/client';
import { randomUUID } from 'crypto';
import { TRACKING_EVENT_BUS } from '../../shared/kafka/kafka.constants';
import type { TrackingEventBus } from '../../shared/kafka/interfaces/tracking-event-bus.interface';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuthorizationService } from '../auth/authorization.service';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CreateDriverTrackingTokenDto } from './dto/create-driver-tracking-token.dto';
import { CreateTrackingTestTokenDto } from './dto/create-tracking-test-token.dto';
import { PublishTestOrderEventDto } from './dto/publish-test-order-event.dto';

@Injectable()
export class TrackingTestingService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly authorizationService: AuthorizationService,
    @Inject(TRACKING_EVENT_BUS)
    private readonly trackingEventBus: TrackingEventBus,
  ) {}

  async createToken(input: CreateTrackingTestTokenDto) {
    const token = await this.signTrackingToken({
      subject: input.subject ?? `${input.role}-swagger-tester`,
      shipmentId: input.shipmentId,
      organizationId: input.organizationId,
      role: input.role,
      destinationLatitude: input.destinationLatitude,
      destinationLongitude: input.destinationLongitude,
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

  async createDriverToken(user: JwtPayload, input: CreateDriverTrackingTokenDto) {
    const shipmentAccess = await this.authorizationService.assertShipmentAccess(
      user,
      input.shipmentId,
      {
        allowedOrganizationRoles: [
          OrganizationRole.ORG_ADMIN,
          OrganizationRole.DISPATCHER,
          OrganizationRole.OPERATIONS,
        ],
        allowAssignedDriver: true,
      },
    );

    const shipment = await this.prisma.shipment.findUnique({
      where: { id: input.shipmentId },
      select: {
        id: true,
        organizationId: true,
        currentDriverId: true,
        adminFormData: true,
      },
    });

    if (!shipment) {
      throw new BadRequestException('Shipment not found');
    }

    const driverProfile = await this.prisma.driver.findFirst({
      where: {
        organizationId: shipmentAccess.organizationId,
        userId: user.sub,
      },
      select: {
        id: true,
        fullName: true,
      },
    });

    if (!driverProfile) {
      throw new ForbiddenException(
        'The signed-in user is not linked to a driver profile for this organization',
      );
    }

    if (shipment.currentDriverId && shipment.currentDriverId !== driverProfile.id) {
      throw new ForbiddenException('This shipment is assigned to a different driver');
    }

    const destination = this.resolveTrackingDestination(shipment, input);

    const token = await this.signTrackingToken({
      subject: user.email ?? driverProfile.fullName,
      shipmentId: input.shipmentId,
      organizationId: shipment.organizationId,
      role: 'rider',
      destinationLatitude: destination?.latitude,
      destinationLongitude: destination?.longitude,
    });

    return {
      token,
      namespace: '/tracking',
      event: 'location:update',
      shipmentId: input.shipmentId,
      driverId: driverProfile.id,
      organizationId: shipment.organizationId,
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

  private async signTrackingToken(input: {
    subject: string;
    shipmentId: string;
    organizationId: string;
    role: 'rider' | 'customer';
    destinationLatitude?: number;
    destinationLongitude?: number;
  }) {
    return this.jwtService.signAsync({
      sub: input.subject,
      shipmentId: input.shipmentId,
      organizationId: input.organizationId,
      role: input.role,
      ...(input.destinationLatitude !== undefined &&
      input.destinationLongitude !== undefined
        ? {
            destination: {
              latitude: input.destinationLatitude,
              longitude: input.destinationLongitude,
            },
          }
        : {}),
    });
  }

  private resolveTrackingDestination(
    shipment: { adminFormData?: unknown },
    input: CreateDriverTrackingTokenDto,
  ) {
    if (
      input.destinationLatitude !== undefined &&
      input.destinationLongitude !== undefined
    ) {
      return {
        latitude: input.destinationLatitude,
        longitude: input.destinationLongitude,
      };
    }

    const adminFormData =
      shipment.adminFormData &&
      typeof shipment.adminFormData === 'object' &&
      !Array.isArray(shipment.adminFormData)
        ? (shipment.adminFormData as Record<string, unknown>)
        : null;

    const latitude = Number(adminFormData?.destinationLatitude);
    const longitude = Number(adminFormData?.destinationLongitude);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return null;
    }

    return {
      latitude,
      longitude,
    };
  }
}
