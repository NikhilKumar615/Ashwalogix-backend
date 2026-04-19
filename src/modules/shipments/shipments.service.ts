import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  DocumentEntityType,
  EventSource,
  ProofType,
  Prisma,
  ShipmentMode,
  ShipmentPriority,
  ShipmentAssignmentStatus,
  ShipmentStatus,
  ShipmentType,
  StopStatus,
  TrackingSessionStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { TRACKING_EVENT_BUS } from '../../shared/kafka/kafka.constants';
import type {
  OrderEventMessage,
  TrackingEventBus,
} from '../../shared/kafka/interfaces/tracking-event-bus.interface';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  buildBusinessPrefix,
  formatRollingAlphaCode,
  parseRollingAlphaCodeSequence,
} from '../../shared/codes/entity-code.util';
import { AssignDriverDto } from './dto/assign-driver.dto';
import { CreateShipmentDto } from './dto/create-shipment.dto';
import { CreateProofOfDeliveryDto } from './dto/create-proof-of-delivery.dto';
import { CreateTrackingPointDto } from './dto/create-tracking-point.dto';
import { FailShipmentDto } from './dto/fail-shipment.dto';
import { ShipmentStatusActionDto } from './dto/shipment-status-action.dto';
import { StartTrackingSessionDto } from './dto/start-tracking-session.dto';
import { UpdateShipmentDto } from './dto/update-shipment.dto';

type ListShipmentsParams = {
  organizationId?: string;
  organizationIds?: string[];
  status?: ShipmentStatus;
};

type Coordinate = {
  latitude: number;
  longitude: number;
};

type TrackingRoutePoint = Coordinate & {
  id?: string;
  accuracy?: number | null;
  recordedAt?: Date | string | null;
};

type SnappedRouteResponse = {
  source: 'google_roads' | 'google_directions' | 'osrm' | 'raw';
  points: Coordinate[];
  rawPointCount: number;
  routedPointCount: number;
  cached: boolean;
  providerErrors?: string[];
};

type SnappedRouteCacheEntry = {
  expiresAt: number;
  response: SnappedRouteResponse;
};

const OSRM_MATCH_BASE_URL = 'https://router.project-osrm.org/match/v1/driving';
const OSRM_ROUTE_BASE_URL = 'https://router.project-osrm.org/route/v1/driving';
const GOOGLE_DIRECTIONS_BASE_URL =
  'https://maps.googleapis.com/maps/api/directions/json';
const GOOGLE_ROADS_SNAP_BASE_URL = 'https://roads.googleapis.com/v1/snapToRoads';
const ROUTE_CACHE_TTL_MS = 5 * 60 * 1000;
const ROUTE_BATCH_SIZE = 20;
const ROUTE_CONCURRENCY = 2;
const GOOGLE_ROADS_POINT_BATCH_SIZE = 100;
const GOOGLE_DIRECTIONS_POINT_BATCH_SIZE = 25;
const MIN_ROUTE_POINT_DISTANCE_METRES = 5;
const MIN_SNAP_POINT_DISTANCE_METRES = 35;
const MAX_SNAP_POINTS = 220;
const MAX_ROUTE_POINT_ACCURACY_METRES = 50;
const MAX_ROUTE_CACHE_ENTRIES = 80;

const geocodeCache = new Map<string, Coordinate | null>();
const reverseGeocodeCache = new Map<string, string | null>();
const snappedRouteCache = new Map<string, SnappedRouteCacheEntry>();

@Injectable()
export class ShipmentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TRACKING_EVENT_BUS)
    private readonly trackingEventBus: TrackingEventBus,
  ) {}

  async listShipments(params: ListShipmentsParams) {
    if (params.organizationId) {
      await this.normalizeShipmentCodes(params.organizationId);
    } else if (params.organizationIds?.length) {
      await Promise.all(
        params.organizationIds.map((organizationId) =>
          this.normalizeShipmentCodes(organizationId),
        ),
      );
    }

    const where: Prisma.ShipmentWhereInput = {};

    if (params.organizationId) {
      where.organizationId = params.organizationId;
    } else if (params.organizationIds?.length) {
      where.organizationId = {
        in: params.organizationIds,
      };
    }

    if (params.status) {
      where.status = params.status;
    }

    const shipments = await this.prisma.shipment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        companyClient: true,
        currentDriver: true,
        currentVehicle: true,
      },
    });

    return Promise.all(
      shipments.map((shipment) => this.enrichShipmentCoordinates(shipment)),
    );
  }

  async getShipmentById(id: string) {
    const shipmentForNormalization = await this.prisma.shipment.findUnique({
      where: { id },
      select: { organizationId: true },
    });

    if (shipmentForNormalization?.organizationId) {
      await this.normalizeShipmentCodes(shipmentForNormalization.organizationId);
    }

    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
      include: {
        companyClient: true,
        sourceLocation: true,
        destinationLocation: true,
        currentDriver: true,
        currentVehicle: true,
        items: true,
        stops: {
          orderBy: { stopSequence: 'asc' },
        },
        assignments: {
          include: {
            driver: true,
            vehicle: true,
          },
          orderBy: { assignedAt: 'desc' },
        },
        statusEvents: {
          include: {
            driver: true,
          },
          orderBy: { eventTime: 'desc' },
        },
        trackingSessions: {
          orderBy: { startedAt: 'desc' },
        },
        documents: {
          orderBy: { uploadedAt: 'desc' },
        },
        proofOfDeliveries: {
          include: {
            photoDocument: true,
            signatureDocument: true,
          },
          orderBy: { capturedAt: 'desc' },
        },
      },
    });

    return shipment ? this.enrichShipmentCoordinates(shipment) : null;
  }

  async getShipmentByCode(shipmentCode: string) {
    const normalizedCode = shipmentCode.trim().toUpperCase();

    const shipment = await this.prisma.shipment.findFirst({
      where: {
        shipmentCode: normalizedCode,
      },
      include: {
        companyClient: true,
        sourceLocation: true,
        destinationLocation: true,
        currentDriver: true,
        currentVehicle: true,
        assignments: {
          include: {
            driver: true,
            vehicle: true,
          },
          orderBy: { assignedAt: 'desc' },
        },
        items: true,
        stops: {
          orderBy: { stopSequence: 'asc' },
        },
        statusEvents: {
          include: {
            driver: true,
          },
          orderBy: { eventTime: 'desc' },
        },
        trackingSessions: {
          orderBy: { startedAt: 'desc' },
        },
        documents: {
          orderBy: { uploadedAt: 'desc' },
        },
        proofOfDeliveries: {
          include: {
            photoDocument: true,
            signatureDocument: true,
          },
          orderBy: { capturedAt: 'desc' },
        },
      },
    });

    if (!shipment) {
      return null;
    }

    return this.enrichShipmentCoordinates(shipment);
  }

  async getShipmentTimeline(id: string) {
    await this.ensureShipmentExists(id);

    return this.prisma.shipmentStatusEvent.findMany({
      where: { shipmentId: id },
      include: {
        driver: true,
      },
      orderBy: { eventTime: 'desc' },
    });
  }

  async createShipment(input: CreateShipmentDto) {
    this.validateCreateShipmentInput(input);

    const status = ShipmentStatus.DRAFT;
    const shipmentCode = await this.generateShipmentCode(input.organizationId);
    const resolvedCompanyClientId = input.companyClientId;

    const shipment = await this.prisma.shipment.create({
      data: {
        organizationId: input.organizationId,
        companyClientId: resolvedCompanyClientId,
        shipmentMode: input.shipmentMode,
        shipmentCode,
        shipmentType: input.shipmentType,
        priority: input.priority ?? ShipmentPriority.MEDIUM,
        status,
        sourceLocationId: input.sourceLocationId,
        destinationLocationId: input.destinationLocationId,
        plannedPickupAt: input.plannedPickupAt
          ? new Date(input.plannedPickupAt)
          : null,
        plannedDeliveryAt: input.plannedDeliveryAt
          ? new Date(input.plannedDeliveryAt)
          : null,
        invoiceNumber: input.invoiceNumber,
        invoiceDate: input.invoiceDate ? new Date(input.invoiceDate) : null,
        invoiceAmount:
          input.invoiceAmount !== undefined
            ? new Prisma.Decimal(input.invoiceAmount)
            : undefined,
        internalSenderName: input.internalSenderName,
        internalSenderPhone: input.internalSenderPhone,
        internalSenderDepartment: input.internalSenderDepartment,
        internalReceiverName: input.internalReceiverName,
        internalReceiverPhone: input.internalReceiverPhone,
        internalReceiverDepartment: input.internalReceiverDepartment,
        notes: input.notes,
        adminFormData:
          input.adminFormData !== undefined
            ? (input.adminFormData as Prisma.InputJsonValue)
            : undefined,
        items: input.items?.length
          ? {
              create: input.items.map((item) => ({
                organizationId: input.organizationId,
                description: item.description,
                quantity: new Prisma.Decimal(item.quantity),
                unit: item.unit,
                weight:
                  item.weight !== undefined
                    ? new Prisma.Decimal(item.weight)
                    : undefined,
                volume:
                  item.volume !== undefined
                    ? new Prisma.Decimal(item.volume)
                    : undefined,
                declaredValue:
                  item.declaredValue !== undefined
                    ? new Prisma.Decimal(item.declaredValue)
                    : undefined,
              })),
            }
          : undefined,
        stops: input.stops?.length
          ? {
              create: input.stops.map((stop) => ({
                organizationId: input.organizationId,
                stopSequence: stop.stopSequence,
                stopType: stop.stopType,
                locationName: stop.locationName,
                addressLine1: stop.addressLine1,
                addressLine2: stop.addressLine2,
                city: stop.city,
                state: stop.state,
                postalCode: stop.postalCode,
                country: stop.country ?? 'India',
                plannedArrivalAt: stop.plannedArrivalAt
                  ? new Date(stop.plannedArrivalAt)
                  : undefined,
                plannedDepartureAt: stop.plannedDepartureAt
                  ? new Date(stop.plannedDepartureAt)
                  : undefined,
                status: StopStatus.PENDING,
              })),
            }
          : undefined,
        statusEvents: {
          create: {
            organizationId: input.organizationId,
            eventType: 'shipment_created',
            toStatus: status,
            source: input.eventSource ?? EventSource.API,
            notes: 'Shipment created via API',
            metadata: {
              shipmentMode: input.shipmentMode,
              shipmentType: input.shipmentType,
              priority: input.priority ?? ShipmentPriority.MEDIUM,
            },
          },
        },
      },
      include: {
        companyClient: true,
        items: true,
        stops: {
          orderBy: { stopSequence: 'asc' },
        },
        statusEvents: {
          orderBy: { eventTime: 'desc' },
        },
      },
    });

    return this.enrichShipmentCoordinates(shipment);
  }

  async updateShipment(shipmentId: string, input: UpdateShipmentDto) {
    const existingShipment = await this.ensureShipmentExists(shipmentId);

    const organizationId = existingShipment.organizationId;
    const normalizedInput: CreateShipmentDto = {
      organizationId,
      shipmentMode: input.shipmentMode ?? existingShipment.shipmentMode,
      shipmentType: input.shipmentType ?? existingShipment.shipmentType,
      priority: input.priority ?? existingShipment.priority ?? undefined,
      shipmentCode: input.shipmentCode ?? existingShipment.shipmentCode,
      companyClientId:
        input.shipmentMode === ShipmentMode.INTERNAL
          ? undefined
          : input.companyClientId !== undefined
          ? input.companyClientId
          : existingShipment.companyClientId ?? undefined,
      sourceLocationId:
        input.sourceLocationId !== undefined
          ? input.sourceLocationId
          : existingShipment.sourceLocationId ?? undefined,
      destinationLocationId:
        input.destinationLocationId !== undefined
          ? input.destinationLocationId
          : existingShipment.destinationLocationId ?? undefined,
      plannedPickupAt:
        input.plannedPickupAt !== undefined
          ? input.plannedPickupAt
          : existingShipment.plannedPickupAt?.toISOString(),
      plannedDeliveryAt:
        input.plannedDeliveryAt !== undefined
          ? input.plannedDeliveryAt
          : existingShipment.plannedDeliveryAt?.toISOString(),
      invoiceNumber:
        input.invoiceNumber !== undefined
          ? input.invoiceNumber
          : existingShipment.invoiceNumber ?? undefined,
      invoiceDate:
        input.invoiceDate !== undefined
          ? input.invoiceDate
          : existingShipment.invoiceDate?.toISOString(),
      invoiceAmount:
        input.invoiceAmount !== undefined
          ? input.invoiceAmount
          : existingShipment.invoiceAmount !== null &&
              existingShipment.invoiceAmount !== undefined
            ? Number(existingShipment.invoiceAmount)
            : undefined,
      internalSenderName:
        input.internalSenderName !== undefined
          ? input.internalSenderName
          : existingShipment.internalSenderName ?? undefined,
      internalSenderPhone:
        input.internalSenderPhone !== undefined
          ? input.internalSenderPhone
          : existingShipment.internalSenderPhone ?? undefined,
      internalSenderDepartment:
        input.internalSenderDepartment !== undefined
          ? input.internalSenderDepartment
          : existingShipment.internalSenderDepartment ?? undefined,
      internalReceiverName:
        input.internalReceiverName !== undefined
          ? input.internalReceiverName
          : existingShipment.internalReceiverName ?? undefined,
      internalReceiverPhone:
        input.internalReceiverPhone !== undefined
          ? input.internalReceiverPhone
          : existingShipment.internalReceiverPhone ?? undefined,
      internalReceiverDepartment:
        input.internalReceiverDepartment !== undefined
          ? input.internalReceiverDepartment
          : existingShipment.internalReceiverDepartment ?? undefined,
      notes:
        input.notes !== undefined ? input.notes : existingShipment.notes ?? undefined,
      adminFormData:
        input.adminFormData !== undefined
          ? input.adminFormData
          : ((existingShipment.adminFormData as Record<string, unknown> | null) ?? undefined),
      items: input.items,
      stops: input.stops,
      initialStatus:
        input.initialStatus !== undefined
          ? input.initialStatus
          : existingShipment.status,
      eventSource: input.eventSource ?? EventSource.API,
    };

    this.validateCreateShipmentInput(normalizedInput);

    const shipment = await this.prisma.$transaction(async (tx) => {
      if (input.items) {
        await tx.shipmentItem.deleteMany({
          where: {
            shipmentId,
          },
        });
      }

      if (input.stops) {
        await tx.shipmentStop.deleteMany({
          where: {
            shipmentId,
          },
        });
      }

      const updated = await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          companyClientId: normalizedInput.companyClientId ?? null,
          shipmentMode: normalizedInput.shipmentMode,
          shipmentCode: normalizedInput.shipmentCode,
          shipmentType: normalizedInput.shipmentType,
          priority: normalizedInput.priority ?? ShipmentPriority.MEDIUM,
          sourceLocationId: normalizedInput.sourceLocationId ?? null,
          destinationLocationId: normalizedInput.destinationLocationId ?? null,
          plannedPickupAt: normalizedInput.plannedPickupAt
            ? new Date(normalizedInput.plannedPickupAt)
            : null,
          plannedDeliveryAt: normalizedInput.plannedDeliveryAt
            ? new Date(normalizedInput.plannedDeliveryAt)
            : null,
          invoiceNumber: normalizedInput.invoiceNumber ?? null,
          invoiceDate: normalizedInput.invoiceDate
            ? new Date(normalizedInput.invoiceDate)
            : null,
          invoiceAmount:
            normalizedInput.invoiceAmount !== undefined
              ? new Prisma.Decimal(normalizedInput.invoiceAmount)
              : null,
          internalSenderName: normalizedInput.internalSenderName ?? null,
          internalSenderPhone: normalizedInput.internalSenderPhone ?? null,
          internalSenderDepartment:
            normalizedInput.internalSenderDepartment ?? null,
          internalReceiverName: normalizedInput.internalReceiverName ?? null,
          internalReceiverPhone: normalizedInput.internalReceiverPhone ?? null,
          internalReceiverDepartment:
            normalizedInput.internalReceiverDepartment ?? null,
          notes: normalizedInput.notes ?? null,
          adminFormData:
            normalizedInput.adminFormData !== undefined
              ? (normalizedInput.adminFormData as Prisma.InputJsonValue)
              : Prisma.DbNull,
          items: normalizedInput.items?.length
            ? {
                create: normalizedInput.items.map((item) => ({
                  organizationId,
                  description: item.description,
                  quantity: new Prisma.Decimal(item.quantity),
                  unit: item.unit,
                  weight:
                    item.weight !== undefined
                      ? new Prisma.Decimal(item.weight)
                      : undefined,
                  volume:
                    item.volume !== undefined
                      ? new Prisma.Decimal(item.volume)
                      : undefined,
                  declaredValue:
                    item.declaredValue !== undefined
                      ? new Prisma.Decimal(item.declaredValue)
                      : undefined,
                })),
              }
            : input.items
              ? undefined
              : undefined,
          stops: normalizedInput.stops?.length
            ? {
                create: normalizedInput.stops.map((stop) => ({
                  organizationId,
                  stopSequence: stop.stopSequence,
                  stopType: stop.stopType,
                  locationName: stop.locationName,
                  addressLine1: stop.addressLine1,
                  addressLine2: stop.addressLine2,
                  city: stop.city,
                  state: stop.state,
                  postalCode: stop.postalCode,
                  country: stop.country ?? 'India',
                  plannedArrivalAt: stop.plannedArrivalAt
                    ? new Date(stop.plannedArrivalAt)
                    : undefined,
                  plannedDepartureAt: stop.plannedDepartureAt
                    ? new Date(stop.plannedDepartureAt)
                    : undefined,
                  status: StopStatus.PENDING,
                })),
              }
            : input.stops
              ? undefined
              : undefined,
          status:
            input.initialStatus !== undefined
              ? input.initialStatus
              : existingShipment.status,
        },
        include: {
          companyClient: true,
          sourceLocation: true,
          destinationLocation: true,
          currentDriver: true,
          currentVehicle: true,
          items: true,
          stops: {
            orderBy: { stopSequence: 'asc' },
          },
          assignments: {
            include: {
              driver: true,
              vehicle: true,
            },
            orderBy: { assignedAt: 'desc' },
          },
          statusEvents: {
            include: {
              driver: true,
            },
            orderBy: { eventTime: 'desc' },
          },
          trackingSessions: {
            orderBy: { startedAt: 'desc' },
          },
          documents: {
            orderBy: { uploadedAt: 'desc' },
          },
          proofOfDeliveries: {
            include: {
              photoDocument: true,
              signatureDocument: true,
            },
            orderBy: { capturedAt: 'desc' },
          },
        },
      });

      await tx.shipmentStatusEvent.create({
        data: {
          organizationId,
          shipmentId,
          eventType: 'shipment_updated',
          fromStatus: existingShipment.status,
          toStatus:
            input.initialStatus !== undefined
              ? input.initialStatus
              : existingShipment.status,
          source: normalizedInput.eventSource ?? EventSource.API,
          notes: 'Shipment updated via API',
          metadata: {
            shipmentMode: normalizedInput.shipmentMode,
            shipmentType: normalizedInput.shipmentType,
            priority: normalizedInput.priority ?? ShipmentPriority.MEDIUM,
          },
        },
      });

      return updated;
    });

    return this.enrichShipmentCoordinates(shipment);
  }

  async assignDriver(shipmentId: string, input: AssignDriverDto) {
    const shipment = await this.ensureShipmentExists(shipmentId);
    await this.ensureDriverExists(input.driverId, input.organizationId);

    if (input.vehicleId) {
      await this.ensureVehicleExists(input.vehicleId, input.organizationId);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.shipmentAssignment.updateMany({
        where: {
          shipmentId,
          assignmentStatus: ShipmentAssignmentStatus.ACTIVE,
        },
        data: {
          assignmentStatus: ShipmentAssignmentStatus.CLOSED,
          unassignedAt: new Date(),
        },
      });

      const assignment = await tx.shipmentAssignment.create({
        data: {
          organizationId: input.organizationId,
          shipmentId,
          driverId: input.driverId,
          vehicleId: input.vehicleId,
          notes: input.notes,
        },
        include: {
          driver: true,
          vehicle: true,
        },
      });

      const nextStatus =
        shipment.status === ShipmentStatus.PLANNED
          ? ShipmentStatus.ASSIGNED
          : shipment.status;

      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          currentDriverId: input.driverId,
          currentVehicleId: input.vehicleId,
          status: nextStatus,
        },
      });

      const event = {
        organizationId: input.organizationId,
        shipmentId,
        driverId: input.driverId,
        eventType: 'driver_assigned',
        fromStatus: shipment.status,
        toStatus: nextStatus,
        source: EventSource.API,
        notes: input.notes ?? 'Driver assigned to shipment',
        metadata: {
          vehicleId: input.vehicleId,
        },
      };

      await tx.shipmentStatusEvent.create({
        data: event,
      });

      return {
        assignment,
        orderEvent: this.toOrderEventMessage(event),
      };
    });

    await this.publishOrderEventSafe(result.orderEvent);
    return result.assignment;
  }

  async startTrackingSession(
    shipmentId: string,
    input: StartTrackingSessionDto,
  ) {
    const shipment = await this.ensureShipmentExists(shipmentId);

    if (shipment.organizationId !== input.organizationId) {
      throw new BadRequestException(
        'organizationId does not match the shipment organization',
      );
    }

    if (shipment.currentDriverId !== input.driverId) {
      throw new BadRequestException(
        'The provided driver is not the current driver for this shipment',
      );
    }

    const activeSession = shipment.currentTrackingSessionId
      ? await this.prisma.trackingSession.findUnique({
          where: { id: shipment.currentTrackingSessionId },
        })
      : null;

    if (activeSession && activeSession.status === TrackingSessionStatus.ACTIVE) {
      return activeSession;
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const trackingSession = await tx.trackingSession.create({
        data: {
          organizationId: input.organizationId,
          shipmentId,
          driverId: input.driverId,
          status: TrackingSessionStatus.ACTIVE,
        },
      });

      const nextStatus =
        shipment.status === ShipmentStatus.ASSIGNED
          ? ShipmentStatus.EN_ROUTE_PICKUP
          : shipment.status;

      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          currentTrackingSessionId: trackingSession.id,
          status: nextStatus,
        },
      });

      const event = {
        organizationId: input.organizationId,
        shipmentId,
        driverId: input.driverId,
        eventType: 'tracking_started',
        fromStatus: shipment.status,
        toStatus: nextStatus,
        source: EventSource.API,
        notes: 'Tracking session started',
        metadata: {
          trackingSessionId: trackingSession.id,
        },
      };

      await tx.shipmentStatusEvent.create({
        data: event,
      });

      return {
        trackingSession,
        orderEvent: this.toOrderEventMessage(event),
      };
    });

    await this.publishOrderEventSafe(result.orderEvent);
    return result.trackingSession;
  }

  async addTrackingPoint(shipmentId: string, input: CreateTrackingPointDto) {
    const shipment = await this.ensureShipmentExists(shipmentId);

    if (shipment.organizationId !== input.organizationId) {
      throw new BadRequestException(
        'organizationId does not match the shipment organization',
      );
    }

    const trackingSessionId =
      input.trackingSessionId ?? shipment.currentTrackingSessionId;

    if (!trackingSessionId) {
      throw new BadRequestException(
        'No active tracking session found for this shipment',
      );
    }

    const trackingSession = await this.prisma.trackingSession.findUnique({
      where: { id: trackingSessionId },
    });

    if (!trackingSession || trackingSession.status !== TrackingSessionStatus.ACTIVE) {
      throw new BadRequestException('Tracking session is not active');
    }

    return this.prisma.trackingPoint.create({
      data: {
        organizationId: input.organizationId,
        trackingSessionId,
        shipmentId,
        driverId: input.driverId,
        latitude: new Prisma.Decimal(input.latitude),
        longitude: new Prisma.Decimal(input.longitude),
        speed:
          input.speed !== undefined
            ? new Prisma.Decimal(input.speed)
            : undefined,
        heading:
          input.heading !== undefined
            ? new Prisma.Decimal(input.heading)
            : undefined,
        accuracy:
          input.accuracy !== undefined
            ? new Prisma.Decimal(input.accuracy)
            : undefined,
      },
    });
  }

  async getLatestTrackingPoint(shipmentId: string) {
    await this.ensureShipmentExists(shipmentId);

    return this.prisma.trackingPoint.findFirst({
      where: { shipmentId },
      orderBy: { recordedAt: 'desc' },
    });
  }

  async getTrackingHistory(shipmentId: string, limit?: number) {
    await this.ensureShipmentExists(shipmentId);

    const safeLimit =
      limit !== undefined && limit !== null && Number.isFinite(Number(limit))
        ? Math.max(Number(limit), 1)
        : null;

    return this.prisma.trackingPoint.findMany({
      where: { shipmentId },
      orderBy: { recordedAt: 'desc' },
      ...(safeLimit ? { take: safeLimit } : {}),
    });
  }

  async getSnappedTrackingRoute(shipmentId: string): Promise<SnappedRouteResponse> {
    await this.ensureShipmentExists(shipmentId);

    const trackingPoints = await this.prisma.trackingPoint.findMany({
      where: { shipmentId },
      orderBy: { recordedAt: 'asc' },
      select: {
        id: true,
        latitude: true,
        longitude: true,
        accuracy: true,
        recordedAt: true,
      },
    });
    const routePoints = this.filterRoutePoints(
      trackingPoints.map((point) => this.toTrackingRoutePoint(point)),
    );
    const latestPoint = trackingPoints[trackingPoints.length - 1] || null;
    const cacheKey = [
      shipmentId,
      trackingPoints.length,
      latestPoint?.id || 'none',
      latestPoint?.recordedAt?.toISOString() || 'none',
    ].join(':');
    const cachedRoute = snappedRouteCache.get(cacheKey);

    if (cachedRoute && cachedRoute.expiresAt > Date.now()) {
      return {
        ...cachedRoute.response,
        cached: true,
      };
    }

    const fallbackResponse: SnappedRouteResponse = {
      source: 'raw',
      points: routePoints,
      rawPointCount: routePoints.length,
      routedPointCount: routePoints.length,
      cached: false,
    };

    if (routePoints.length < 2) {
      this.setSnappedRouteCache(cacheKey, fallbackResponse);
      return fallbackResponse;
    }

    const hasGoogleDirections = Boolean(process.env.GOOGLE_MAPS_API_KEY?.trim());

    try {
      const points = hasGoogleDirections
        ? await this.fetchGoogleRoadsRoute(routePoints)
        : await this.fetchOsrmSnappedRoute(routePoints);
      const response: SnappedRouteResponse = {
        source: hasGoogleDirections ? 'google_roads' : 'osrm',
        points,
        rawPointCount: routePoints.length,
        routedPointCount: points.length,
        cached: false,
      };
      this.setSnappedRouteCache(cacheKey, response);
      return response;
    } catch (primaryError) {
      const providerErrors = [this.toProviderErrorMessage('primary', primaryError)];
      if (!hasGoogleDirections) {
        fallbackResponse.providerErrors = providerErrors;
        this.setSnappedRouteCache(cacheKey, fallbackResponse);
        return fallbackResponse;
      }

      try {
        const points = await this.fetchGoogleDirectionsRoute(routePoints);
        const response: SnappedRouteResponse = {
          source: 'google_directions',
          points,
          rawPointCount: routePoints.length,
          routedPointCount: points.length,
          cached: false,
        };
        this.setSnappedRouteCache(cacheKey, response);
        return response;
      } catch (directionsError) {
        providerErrors.push(
          this.toProviderErrorMessage('google_directions', directionsError),
        );
        try {
          const points = await this.fetchOsrmSnappedRoute(routePoints);
          const response: SnappedRouteResponse = {
            source: 'osrm',
            points,
            rawPointCount: routePoints.length,
            routedPointCount: points.length,
            cached: false,
          };
          this.setSnappedRouteCache(cacheKey, response);
          return response;
        } catch (osrmError) {
          providerErrors.push(this.toProviderErrorMessage('osrm', osrmError));
          fallbackResponse.providerErrors = providerErrors;
          this.setSnappedRouteCache(cacheKey, fallbackResponse);
          return fallbackResponse;
        }
      }
    }
  }

  async reverseGeocodeCoordinates(
    latitude: number,
    longitude: number,
  ): Promise<string | null> {
    const coordinate = this.firstValidCoordinate([latitude, longitude]);
    if (!coordinate) {
      return null;
    }

    const cacheKey = `${coordinate.latitude.toFixed(6)},${coordinate.longitude.toFixed(6)}`;
    if (reverseGeocodeCache.has(cacheKey)) {
      return reverseGeocodeCache.get(cacheKey) ?? null;
    }

    try {
      const googleApiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
      const label = googleApiKey
        ? await this.reverseGeocodeWithGoogle(coordinate, googleApiKey)
        : await this.reverseGeocodeWithNominatim(coordinate);

      reverseGeocodeCache.set(cacheKey, label);
      return label;
    } catch {
      reverseGeocodeCache.set(cacheKey, null);
      return null;
    }
  }

  async getTrackingStatus(shipmentId: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: {
        currentDriver: true,
        currentVehicle: true,
      },
    });

    if (!shipment) {
      throw new BadRequestException(`Shipment ${shipmentId} does not exist`);
    }

    const activeTrackingSession = shipment.currentTrackingSessionId
      ? await this.prisma.trackingSession.findUnique({
          where: { id: shipment.currentTrackingSessionId },
        })
      : null;

    const latestTrackingPoint = await this.prisma.trackingPoint.findFirst({
      where: { shipmentId },
      orderBy: { recordedAt: 'desc' },
    });

    return {
      shipmentId: shipment.id,
      shipmentCode: shipment.shipmentCode,
      shipmentStatus: shipment.status,
      currentDriver: shipment.currentDriver,
      currentVehicle: shipment.currentVehicle,
      trackingSession: activeTrackingSession,
      latestTrackingPoint,
      lastPingAt: latestTrackingPoint?.recordedAt ?? null,
      isTrackingActive:
        activeTrackingSession?.status === TrackingSessionStatus.ACTIVE,
    };
  }

  async createProofOfDelivery(
    shipmentId: string,
    input: CreateProofOfDeliveryDto,
  ) {
    const shipment = await this.ensureShipmentExists(shipmentId);

    if (shipment.organizationId !== input.organizationId) {
      throw new BadRequestException(
        'organizationId does not match the shipment organization',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const proof = await tx.proofOfDelivery.create({
        data: {
          organizationId: input.organizationId,
          shipmentId,
          proofType: input.proofType,
          photoDocumentId: input.photoDocumentId,
          signatureDocumentId: input.signatureDocumentId,
          receiverName: input.receiverName,
          receiverPhone: input.receiverPhone,
          remarks: input.remarks,
          capturedBy: input.capturedBy,
        },
      });

      const event = {
        organizationId: input.organizationId,
        shipmentId,
        eventType:
          input.proofType === ProofType.PICKUP
            ? 'pickup_proof_uploaded'
            : 'delivery_proof_uploaded',
        fromStatus: shipment.status,
        toStatus: shipment.status,
        source: EventSource.API,
        notes:
          input.proofType === ProofType.PICKUP
            ? 'Pickup proof recorded'
            : 'Delivery proof recorded',
        metadata: {
          proofType: input.proofType,
          proofId: proof.id,
        },
      };

      await tx.shipmentStatusEvent.create({
        data: event,
      });

      return {
        proof,
        orderEvent: this.toOrderEventMessage(event),
      };
    });

    await this.publishOrderEventSafe(result.orderEvent);
    return result.proof;
  }

  async planShipment(shipmentId: string, input: ShipmentStatusActionDto) {
    return this.confirmShipment(shipmentId, input);
  }

  async confirmShipment(shipmentId: string, input: ShipmentStatusActionDto) {
    const activeAssignment = await this.prisma.shipmentAssignment.findFirst({
      where: {
        shipmentId,
        organizationId: input.organizationId,
        assignmentStatus: ShipmentAssignmentStatus.ACTIVE,
      },
      select: { id: true },
    });

    return this.transitionShipmentStatus(
      shipmentId,
      input.organizationId,
      activeAssignment ? ShipmentStatus.ASSIGNED : ShipmentStatus.PLANNED,
      ['shipment_confirmed'],
      [ShipmentStatus.DRAFT],
      input.notes ?? 'Shipment confirmed',
    );
  }

  async markAtPickup(shipmentId: string, input: ShipmentStatusActionDto) {
    return this.transitionShipmentStatus(
      shipmentId,
      input.organizationId,
      ShipmentStatus.AT_PICKUP,
      ['arrived_pickup'],
      [ShipmentStatus.ASSIGNED, ShipmentStatus.EN_ROUTE_PICKUP],
      input.notes ?? 'Shipment arrived at pickup',
      async (tx) => {
        await tx.shipmentStop.updateMany({
          where: {
            shipmentId,
            stopType: 'PICKUP',
          },
          data: {
            status: StopStatus.ARRIVED,
            actualArrivalAt: new Date(),
          },
        });
      },
    );
  }

  async confirmPickup(shipmentId: string, input: ShipmentStatusActionDto) {
    return this.transitionShipmentStatus(
      shipmentId,
      input.organizationId,
      ShipmentStatus.PICKED_UP,
      ['pickup_completed'],
      [ShipmentStatus.AT_PICKUP],
      input.notes ?? 'Shipment pickup confirmed',
      async (tx) => {
        await tx.shipment.update({
          where: { id: shipmentId },
          data: {
            actualPickupAt: new Date(),
          },
        });
        await tx.shipmentStop.updateMany({
          where: {
            shipmentId,
            stopType: 'PICKUP',
          },
          data: {
            status: StopStatus.COMPLETED,
            actualDepartureAt: new Date(),
          },
        });
      },
    );
  }

  async markInTransit(shipmentId: string, input: ShipmentStatusActionDto) {
    return this.transitionShipmentStatus(
      shipmentId,
      input.organizationId,
      ShipmentStatus.IN_TRANSIT,
      ['shipment_in_transit'],
      [ShipmentStatus.PICKED_UP, ShipmentStatus.AT_PICKUP],
      input.notes ?? 'Shipment marked in transit',
    );
  }

  async markAtDelivery(shipmentId: string, input: ShipmentStatusActionDto) {
    return this.transitionShipmentStatus(
      shipmentId,
      input.organizationId,
      ShipmentStatus.AT_DELIVERY,
      ['arrived_delivery'],
      [ShipmentStatus.IN_TRANSIT, ShipmentStatus.PICKED_UP],
      input.notes ?? 'Shipment arrived at delivery',
      async (tx) => {
        await tx.shipmentStop.updateMany({
          where: {
            shipmentId,
            stopType: 'DELIVERY',
          },
          data: {
            status: StopStatus.ARRIVED,
            actualArrivalAt: new Date(),
          },
        });
      },
    );
  }

  async completeDelivery(shipmentId: string, input: ShipmentStatusActionDto) {
    const deliveryProofCount = await this.prisma.proofOfDelivery.count({
      where: {
        shipmentId,
        organizationId: input.organizationId,
        proofType: ProofType.DELIVERY,
      },
    });

    if (deliveryProofCount === 0) {
      throw new BadRequestException(
        'At least one delivery proof is required before completing delivery',
      );
    }

    return this.transitionShipmentStatus(
      shipmentId,
      input.organizationId,
      ShipmentStatus.DELIVERED,
      ['delivery_completed'],
      [ShipmentStatus.AT_DELIVERY],
      input.notes ?? 'Shipment delivery completed',
      async (tx) => {
        await tx.shipment.update({
          where: { id: shipmentId },
          data: {
            actualDeliveryAt: new Date(),
          },
        });
        await tx.shipmentStop.updateMany({
          where: {
            shipmentId,
            stopType: 'DELIVERY',
          },
          data: {
            status: StopStatus.COMPLETED,
            actualDepartureAt: new Date(),
          },
        });
        await this.closeTrackingSession(tx, shipmentId);
      },
    );
  }

  async completeShipment(shipmentId: string, input: ShipmentStatusActionDto) {
    return this.transitionShipmentStatus(
      shipmentId,
      input.organizationId,
      ShipmentStatus.COMPLETED,
      ['shipment_completed'],
      [ShipmentStatus.DELIVERED],
      input.notes ?? 'Shipment completed',
    );
  }

  async failShipment(shipmentId: string, input: FailShipmentDto) {
    return this.transitionShipmentStatus(
      shipmentId,
      input.organizationId,
      ShipmentStatus.FAILED,
      ['shipment_failed'],
      [
        ShipmentStatus.ASSIGNED,
        ShipmentStatus.EN_ROUTE_PICKUP,
        ShipmentStatus.AT_PICKUP,
        ShipmentStatus.PICKED_UP,
        ShipmentStatus.IN_TRANSIT,
        ShipmentStatus.AT_DELIVERY,
      ],
      input.notes ?? input.reason,
      async (tx) => {
        await this.closeTrackingSession(tx, shipmentId);
      },
      {
        reason: input.reason,
      },
    );
  }

  async cancelShipment(shipmentId: string, input: ShipmentStatusActionDto) {
    return this.transitionShipmentStatus(
      shipmentId,
      input.organizationId,
      ShipmentStatus.CANCELLED,
      ['shipment_cancelled'],
      [ShipmentStatus.DRAFT, ShipmentStatus.PLANNED, ShipmentStatus.ASSIGNED],
      input.notes ?? 'Shipment cancelled',
      async (tx) => {
        await tx.shipmentAssignment.updateMany({
          where: {
            shipmentId,
            assignmentStatus: ShipmentAssignmentStatus.ACTIVE,
          },
          data: {
            assignmentStatus: ShipmentAssignmentStatus.CANCELLED,
            unassignedAt: new Date(),
          },
        });
        await this.closeTrackingSession(tx, shipmentId);
      },
    );
  }

  async deleteShipment(shipmentId: string, organizationId: string) {
    const shipment = await this.ensureShipmentExists(shipmentId);

    if (shipment.organizationId !== organizationId) {
      throw new BadRequestException(
        'organizationId does not match the shipment organization',
      );
    }

    const deletableStatuses = new Set<ShipmentStatus>([
      ShipmentStatus.DRAFT,
      ShipmentStatus.PLANNED,
      ShipmentStatus.CANCELLED,
    ]);

    if (!deletableStatuses.has(shipment.status)) {
      throw new BadRequestException(
        'Only draft, planned, or cancelled shipments can be deleted',
      );
    }

    const [proofCount, trackingPointCount, trackingSessionCount] =
      await Promise.all([
        this.prisma.proofOfDelivery.count({
          where: { shipmentId },
        }),
        this.prisma.trackingPoint.count({
          where: { shipmentId },
        }),
        this.prisma.trackingSession.count({
          where: { shipmentId },
        }),
      ]);

    if (proofCount > 0 || trackingPointCount > 0 || trackingSessionCount > 0) {
      throw new BadRequestException(
        'Shipments with tracking history or proof of delivery cannot be deleted',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.document.deleteMany({
        where: {
          OR: [
            { shipmentId },
            {
              entityType: DocumentEntityType.SHIPMENT,
              entityId: shipmentId,
            },
          ],
        },
      });

      await tx.shipment.delete({
        where: { id: shipmentId },
      });
    });

    return {
      id: shipmentId,
      deleted: true,
    };
  }

  private validateCreateShipmentInput(input: CreateShipmentDto) {
    const resolvedCompanyClientId = input.companyClientId;

    if (!input.organizationId) {
      throw new BadRequestException('organizationId is required');
    }

    if (!Object.values(ShipmentMode).includes(input.shipmentMode)) {
      throw new BadRequestException('shipmentMode is invalid');
    }

    if (
      input.shipmentMode === ShipmentMode.BUSINESS &&
      !resolvedCompanyClientId
    ) {
      throw new BadRequestException(
        'companyClientId is required for BUSINESS shipments',
      );
    }

    if (input.shipmentMode === ShipmentMode.INTERNAL) {
      if (resolvedCompanyClientId) {
        throw new BadRequestException(
          'companyClientId must not be provided for INTERNAL shipments',
        );
      }

      if (!input.internalSenderName || !input.internalReceiverName) {
        throw new BadRequestException(
          'internalSenderName and internalReceiverName are required for INTERNAL shipments',
        );
      }
    }

    if (!Object.values(ShipmentType).includes(input.shipmentType)) {
      throw new BadRequestException('shipmentType is invalid');
    }

    if (
      input.priority &&
      !Object.values(ShipmentPriority).includes(input.priority)
    ) {
      throw new BadRequestException('priority is invalid');
    }

    if (
      input.initialStatus &&
      !Object.values(ShipmentStatus).includes(input.initialStatus)
    ) {
      throw new BadRequestException('initialStatus is invalid');
    }
  }

  private async generateShipmentCode(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });

    if (!organization) {
      throw new BadRequestException('Organization not found');
    }

    const prefix = buildBusinessPrefix(organization.name);
    const existingCodes = await this.prisma.shipment.findMany({
      where: { organizationId },
      select: { shipmentCode: true },
    });
    const nextSequence =
      existingCodes.reduce((highest, shipment) => {
        const sequence = parseRollingAlphaCodeSequence(
          shipment.shipmentCode,
          prefix,
          'SHP',
        );
        return sequence !== null && sequence > highest ? sequence : highest;
      }, -1) + 1;

    return formatRollingAlphaCode(prefix, 'SHP', nextSequence);
  }

  private async normalizeShipmentCodes(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });

    if (!organization) {
      throw new BadRequestException('Organization not found');
    }

    const prefix = buildBusinessPrefix(organization.name);
    const shipments = await this.prisma.shipment.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, shipmentCode: true },
    });
    const usedSequences = new Set<number>();

    for (const shipment of shipments) {
      const parsedSequence = parseRollingAlphaCodeSequence(
        shipment.shipmentCode,
        prefix,
        'SHP',
      );

      if (parsedSequence !== null) {
        usedSequences.add(parsedSequence);
      }
    }

    for (const shipment of shipments) {
      const parsedSequence = parseRollingAlphaCodeSequence(
        shipment.shipmentCode,
        prefix,
        'SHP',
      );

      if (parsedSequence !== null) {
        continue;
      }

      let nextSequence = 0;
      while (usedSequences.has(nextSequence)) {
        nextSequence += 1;
      }

      await this.prisma.shipment.update({
        where: { id: shipment.id },
        data: {
          shipmentCode: formatRollingAlphaCode(prefix, 'SHP', nextSequence),
        },
      });
      usedSequences.add(nextSequence);
    }
  }

  private async transitionShipmentStatus(
    shipmentId: string,
    organizationId: string,
    nextStatus: ShipmentStatus,
    eventTypes: string[],
    allowedFromStatuses: ShipmentStatus[],
    notes: string,
    afterUpdate?: (tx: Prisma.TransactionClient) => Promise<void>,
    metadata?: Prisma.InputJsonValue,
  ) {
    const shipment = await this.ensureShipmentExists(shipmentId);

    if (shipment.organizationId !== organizationId) {
      throw new BadRequestException(
        'organizationId does not match the shipment organization',
      );
    }

    if (!allowedFromStatuses.includes(shipment.status)) {
      throw new BadRequestException(
        `Shipment cannot move from ${shipment.status} to ${nextStatus}`,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          status: nextStatus,
        },
      });

      if (afterUpdate) {
        await afterUpdate(tx);
      }

      const event = {
        organizationId,
        shipmentId,
        eventType: eventTypes[0],
        fromStatus: shipment.status,
        toStatus: nextStatus,
        source: EventSource.API,
        notes,
        metadata,
      };

      await tx.shipmentStatusEvent.create({
        data: event,
      });

      const shipmentDetails = await tx.shipment.findUnique({
        where: { id: shipmentId },
        include: {
          companyClient: true,
          currentDriver: true,
          currentVehicle: true,
          stops: {
            orderBy: { stopSequence: 'asc' },
          },
          statusEvents: {
            orderBy: { eventTime: 'desc' },
            take: 10,
          },
        },
      });

      return {
        shipmentDetails: shipmentDetails
          ? await this.enrichShipmentCoordinates(shipmentDetails)
          : null,
        orderEvent: this.toOrderEventMessage(event),
      };
    });

    await this.publishOrderEventSafe(result.orderEvent);
    return result.shipmentDetails;
  }

  private async closeTrackingSession(
    tx: Prisma.TransactionClient,
    shipmentId: string,
  ) {
    const shipment = await tx.shipment.findUnique({
      where: { id: shipmentId },
    });

    if (!shipment?.currentTrackingSessionId) {
      return;
    }

    await tx.trackingSession.update({
      where: { id: shipment.currentTrackingSessionId },
      data: {
        status: TrackingSessionStatus.COMPLETED,
        endedAt: new Date(),
      },
    });

    await tx.shipment.update({
      where: { id: shipmentId },
      data: {
        currentTrackingSessionId: null,
      },
    });
  }

  private async ensureShipmentExists(id: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
    });

    if (!shipment) {
      throw new BadRequestException(`Shipment ${id} does not exist`);
    }

    return shipment;
  }

  private async ensureDriverExists(driverId: string, organizationId: string) {
    const driver = await this.prisma.driver.findFirst({
      where: {
        id: driverId,
        organizationId,
      },
    });

    if (!driver) {
      throw new BadRequestException(`Driver ${driverId} does not exist`);
    }

    return driver;
  }

  private async ensureVehicleExists(vehicleId: string, organizationId: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: {
        id: vehicleId,
        organizationId,
      },
    });

    if (!vehicle) {
      throw new BadRequestException(`Vehicle ${vehicleId} does not exist`);
    }

    return vehicle;
  }

  private mapShipmentCompanyClient<
    T extends { companyClient?: { companyClientCode?: string } | null },
  >(shipment: T) {
    const { companyClient, ...rest } = shipment;

    return {
      ...rest,
      companyClient: this.mapCompanyClient(companyClient),
    };
  }

  private async enrichShipmentCoordinates<
    T extends {
      adminFormData?: unknown;
      sourceLocation?: Record<string, unknown> | null;
      destinationLocation?: Record<string, unknown> | null;
      sourceAddressSnapshot?: unknown;
      destinationAddressSnapshot?: unknown;
      stops?: Array<Record<string, unknown>> | null;
      companyClient?: { companyClientCode?: string } | null;
    },
  >(shipment: T) {
    const mappedShipment = this.mapShipmentCompanyClient(shipment);
    const resolvedPickupCoordinates = await this.resolveShipmentCoordinate(
      shipment,
      'pickup',
    );
    const resolvedDestinationCoordinates = await this.resolveShipmentCoordinate(
      shipment,
      'destination',
    );

    return {
      ...mappedShipment,
      resolvedPickupCoordinates,
      resolvedDestinationCoordinates,
    };
  }

  private async resolveShipmentCoordinate(
    shipment: {
      adminFormData?: unknown;
      sourceLocation?: Record<string, unknown> | null;
      destinationLocation?: Record<string, unknown> | null;
      sourceAddressSnapshot?: unknown;
      destinationAddressSnapshot?: unknown;
      stops?: Array<Record<string, unknown>> | null;
    },
    kind: 'pickup' | 'destination',
  ) {
    const formData =
      shipment.adminFormData &&
      typeof shipment.adminFormData === 'object' &&
      !Array.isArray(shipment.adminFormData)
        ? (shipment.adminFormData as Record<string, unknown>)
        : {};
    const stopType = kind === 'pickup' ? 'PICKUP' : 'DELIVERY';
    const stop =
      shipment.stops?.find((candidate) => candidate.stopType === stopType) || null;
    const location =
      kind === 'pickup' ? shipment.sourceLocation : shipment.destinationLocation;
    const snapshotValue =
      kind === 'pickup'
        ? shipment.sourceAddressSnapshot
        : shipment.destinationAddressSnapshot;
    const snapshot =
      snapshotValue &&
      typeof snapshotValue === 'object' &&
      !Array.isArray(snapshotValue)
        ? (snapshotValue as Record<string, unknown>)
        : null;

    const directCoordinate = this.firstValidCoordinate(
      [
        formData[kind === 'pickup' ? 'originLatitude' : 'destinationLatitude'],
        formData[kind === 'pickup' ? 'originLongitude' : 'destinationLongitude'],
      ],
      [
        formData[kind === 'pickup' ? 'pickupLatitude' : 'receiverLatitude'],
        formData[kind === 'pickup' ? 'pickupLongitude' : 'receiverLongitude'],
      ],
      [snapshot?.latitude, snapshot?.longitude],
      [stop?.latitude, stop?.longitude],
      [location?.latitude, location?.longitude],
    );

    if (directCoordinate) {
      return directCoordinate;
    }

    const addressCandidates = this.buildAddressCandidates({
      formData,
      stop,
      location,
      snapshot,
      kind,
    });

    for (const candidate of addressCandidates) {
      const geocodedCoordinate = await this.geocodeAddress(candidate);
      if (geocodedCoordinate) {
        return geocodedCoordinate;
      }
    }

    return null;
  }

  private firstValidCoordinate(
    ...pairs: Array<[unknown, unknown] | null | undefined>
  ): Coordinate | null {
    for (const pair of pairs) {
      if (!pair) {
        continue;
      }

      const latitude = Number(pair[0]);
      const longitude = Number(pair[1]);

      if (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        !(latitude === 0 && longitude === 0)
      ) {
        return { latitude, longitude };
      }
    }

    return null;
  }

  private toTrackingRoutePoint(point: {
    id: string;
    latitude: unknown;
    longitude: unknown;
    accuracy?: unknown;
    recordedAt?: Date | string | null;
  }): TrackingRoutePoint {
    return {
      id: point.id,
      latitude: Number(point.latitude),
      longitude: Number(point.longitude),
      accuracy:
        point.accuracy !== null && point.accuracy !== undefined
          ? Number(point.accuracy)
          : null,
      recordedAt: point.recordedAt ?? null,
    };
  }

  private filterRoutePoints(points: TrackingRoutePoint[]) {
    const routePoints: TrackingRoutePoint[] = [];

    for (const point of points) {
      if (!this.isValidCoordinate(point)) {
        continue;
      }

      if (
        Number.isFinite(point.accuracy) &&
        Number(point.accuracy) > MAX_ROUTE_POINT_ACCURACY_METRES
      ) {
        continue;
      }

      const previous = routePoints[routePoints.length - 1];
      if (
        previous &&
        this.calculateDistanceMetres(previous, point) < MIN_ROUTE_POINT_DISTANCE_METRES
      ) {
        continue;
      }

      routePoints.push(point);
    }

    return routePoints;
  }

  private simplifyRoutePointsForSnapping(points: TrackingRoutePoint[]) {
    if (points.length <= 2) {
      return points;
    }

    const distanceFiltered = [points[0]];

    for (const point of points.slice(1, -1)) {
      const previous = distanceFiltered[distanceFiltered.length - 1];
      if (this.calculateDistanceMetres(previous, point) >= MIN_SNAP_POINT_DISTANCE_METRES) {
        distanceFiltered.push(point);
      }
    }

    const lastPoint = points[points.length - 1];
    if (
      this.calculateDistanceMetres(
        distanceFiltered[distanceFiltered.length - 1],
        lastPoint,
      ) > 0
    ) {
      distanceFiltered.push(lastPoint);
    }

    if (distanceFiltered.length <= MAX_SNAP_POINTS) {
      return distanceFiltered;
    }

    const sampled: TrackingRoutePoint[] = [];
    const lastIndex = distanceFiltered.length - 1;
    for (let index = 0; index < MAX_SNAP_POINTS; index += 1) {
      const sourceIndex = Math.round((index * lastIndex) / (MAX_SNAP_POINTS - 1));
      const point = distanceFiltered[sourceIndex];
      const previous = sampled[sampled.length - 1];
      if (
        !previous ||
        previous.latitude !== point.latitude ||
        previous.longitude !== point.longitude
      ) {
        sampled.push(point);
      }
    }

    return sampled;
  }

  private async fetchOsrmSnappedRoute(points: TrackingRoutePoint[]) {
    const snapPoints = this.simplifyRoutePointsForSnapping(points);
    const chunks = this.chunkRoutePoints(snapPoints, ROUTE_BATCH_SIZE);
    const snappedChunks = await this.mapWithConcurrency(
      chunks,
      ROUTE_CONCURRENCY,
      (chunk) => this.fetchOsrmSegment(chunk),
    );
    const route = this.mergeRouteChunks(snappedChunks);

    if (route.length < 2) {
      throw new Error('OSRM returned too few route points');
    }

    return route;
  }

  private async fetchOsrmSegment(points: TrackingRoutePoint[]) {
    try {
      return await this.fetchOsrmMatchSegment(points);
    } catch {
      return this.fetchOsrmRouteSegment(points);
    }
  }

  private async fetchOsrmMatchSegment(points: TrackingRoutePoint[]) {
    const coordinates = this.toOsrmCoordinates(points);
    const radiuses = points
      .map((point) => {
        const accuracy = Number.isFinite(point.accuracy)
          ? Math.max(Number(point.accuracy), 5)
          : 25;
        return Math.min(Math.round(accuracy), MAX_ROUTE_POINT_ACCURACY_METRES);
      })
      .join(';');
    const response = await fetch(
      `${OSRM_MATCH_BASE_URL}/${coordinates}?geometries=polyline&overview=full&tidy=true&radiuses=${radiuses}`,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!response.ok) {
      throw new Error(`OSRM Match returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      code?: string;
      message?: string;
      matchings?: Array<{ geometry?: string }>;
    };
    const route = this.decodeRouteGeometries(
      payload.matchings?.map((matching) => matching.geometry) ?? [],
    );

    if (route.length < 2) {
      throw new Error(payload.message || payload.code || 'OSRM Match returned no geometry');
    }

    return route;
  }

  private async fetchOsrmRouteSegment(points: TrackingRoutePoint[]) {
    const coordinates = this.toOsrmCoordinates(points);
    const response = await fetch(
      `${OSRM_ROUTE_BASE_URL}/${coordinates}?geometries=polyline&overview=full&continue_straight=false`,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!response.ok) {
      throw new Error(`OSRM Route returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      code?: string;
      message?: string;
      routes?: Array<{ geometry?: string }>;
    };
    const route = this.decodeRouteGeometries(
      payload.routes?.map((routeItem) => routeItem.geometry) ?? [],
    );

    if (route.length < 2) {
      throw new Error(payload.message || payload.code || 'OSRM Route returned no geometry');
    }

    return route;
  }

  private async fetchGoogleRoadsRoute(points: TrackingRoutePoint[]) {
    const googleApiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
    if (!googleApiKey) {
      throw new Error('GOOGLE_MAPS_API_KEY is not configured');
    }

    const snapPoints = this.simplifyRoutePointsForSnapping(points);
    const chunks = this.chunkRoutePoints(snapPoints, GOOGLE_ROADS_POINT_BATCH_SIZE);
    const snappedChunks = await this.mapWithConcurrency(chunks, 1, (chunk) =>
      this.fetchGoogleRoadsSegment(chunk, googleApiKey),
    );
    const route = this.mergeRouteChunks(snappedChunks);

    if (route.length < 2) {
      throw new Error('Google Roads returned too few route points');
    }

    return route;
  }

  private async fetchGoogleRoadsSegment(
    points: TrackingRoutePoint[],
    apiKey: string,
  ) {
    const url = new URL(GOOGLE_ROADS_SNAP_BASE_URL);
    url.searchParams.set(
      'path',
      points.map((point) => `${point.latitude},${point.longitude}`).join('|'),
    );
    url.searchParams.set('interpolate', 'true');
    url.searchParams.set('key', apiKey);

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Google Roads returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      error?: { message?: string; status?: string };
      snappedPoints?: Array<{
        location?: { latitude?: number; longitude?: number };
      }>;
    };

    if (payload.error) {
      throw new Error(
        payload.error.message || payload.error.status || 'Google Roads returned an error',
      );
    }

    const route =
      payload.snappedPoints
        ?.map((point) => ({
          latitude: Number(point.location?.latitude),
          longitude: Number(point.location?.longitude),
        }))
        .filter((point) => this.isValidCoordinate(point)) ?? [];

    if (route.length < 2) {
      throw new Error('Google Roads returned no snapped geometry');
    }

    return route;
  }

  private async fetchGoogleDirectionsRoute(points: TrackingRoutePoint[]) {
    const googleApiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
    if (!googleApiKey) {
      throw new Error('GOOGLE_MAPS_API_KEY is not configured');
    }

    const snapPoints = this.simplifyRoutePointsForSnapping(points);
    const chunks = this.chunkRoutePoints(
      snapPoints,
      GOOGLE_DIRECTIONS_POINT_BATCH_SIZE,
    );
    const routedChunks = await this.mapWithConcurrency(chunks, 1, (chunk) =>
      this.fetchGoogleDirectionsSegment(chunk, googleApiKey),
    );
    const route = this.mergeRouteChunks(routedChunks);

    if (route.length < 2) {
      throw new Error('Google Directions returned too few route points');
    }

    return route;
  }

  private async fetchGoogleDirectionsSegment(
    points: TrackingRoutePoint[],
    apiKey: string,
  ) {
    const origin = points[0];
    const destination = points[points.length - 1];
    const waypoints = points.slice(1, -1);
    const url = new URL(GOOGLE_DIRECTIONS_BASE_URL);

    url.searchParams.set('origin', `${origin.latitude},${origin.longitude}`);
    url.searchParams.set(
      'destination',
      `${destination.latitude},${destination.longitude}`,
    );
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('region', 'in');
    url.searchParams.set('key', apiKey);
    if (waypoints.length) {
      url.searchParams.set(
        'waypoints',
        waypoints
          .map((point) => `${point.latitude},${point.longitude}`)
          .join('|'),
      );
    }

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Google Directions returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      status?: string;
      error_message?: string;
      routes?: Array<{ overview_polyline?: { points?: string } }>;
    };
    const encodedPolyline = payload.routes?.[0]?.overview_polyline?.points;

    if (payload.status !== 'OK' || !encodedPolyline) {
      throw new Error(
        payload.error_message || payload.status || 'Google Directions returned no geometry',
      );
    }

    return this.decodePolyline(encodedPolyline);
  }

  private chunkRoutePoints<T>(points: T[], batchSize: number) {
    const chunks: T[][] = [];

    for (let index = 0; index < points.length; index += batchSize - 1) {
      const chunk = points.slice(index, index + batchSize);
      if (chunk.length >= 2) {
        chunks.push(chunk);
      }
    }

    return chunks;
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T) => Promise<R>,
  ) {
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex]);
      }
    }

    const workerCount = Math.min(Math.max(concurrency, 1), items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
  }

  private mergeRouteChunks(chunks: Coordinate[][]) {
    const route: Coordinate[] = [];

    chunks.flat().forEach((point) => {
      const previous = route[route.length - 1];
      if (!previous || this.calculateDistanceMetres(previous, point) >= 1) {
        route.push(point);
      }
    });

    return route;
  }

  private decodeRouteGeometries(geometries: Array<string | undefined>) {
    return geometries.flatMap((geometry) =>
      geometry ? this.decodePolyline(geometry) : [],
    );
  }

  private decodePolyline(polyline: string) {
    const coordinates: Coordinate[] = [];
    let index = 0;
    let latitude = 0;
    let longitude = 0;

    while (index < polyline.length) {
      const latitudeDelta = this.decodePolylineValue(polyline, index);
      index = latitudeDelta.nextIndex;
      latitude += latitudeDelta.value;

      const longitudeDelta = this.decodePolylineValue(polyline, index);
      index = longitudeDelta.nextIndex;
      longitude += longitudeDelta.value;

      coordinates.push({
        latitude: latitude / 100000,
        longitude: longitude / 100000,
      });
    }

    return coordinates.filter((point) => this.isValidCoordinate(point));
  }

  private decodePolylineValue(polyline: string, startIndex: number) {
    let result = 0;
    let shift = 0;
    let index = startIndex;
    let byte = 0;

    do {
      byte = polyline.charCodeAt(index) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
      index += 1;
    } while (byte >= 0x20 && index < polyline.length);

    return {
      value: result & 1 ? ~(result >> 1) : result >> 1,
      nextIndex: index,
    };
  }

  private toOsrmCoordinates(points: TrackingRoutePoint[]) {
    return points
      .map((point) => `${point.longitude.toFixed(6)},${point.latitude.toFixed(6)}`)
      .join(';');
  }

  private isValidCoordinate(point: Coordinate | null | undefined) {
    return (
      !!point &&
      Number.isFinite(point.latitude) &&
      Number.isFinite(point.longitude) &&
      !(point.latitude === 0 && point.longitude === 0)
    );
  }

  private calculateDistanceMetres(start: Coordinate, end: Coordinate) {
    const earthRadiusMetres = 6371000;
    const latitudeDelta = this.toRadians(end.latitude - start.latitude);
    const longitudeDelta = this.toRadians(end.longitude - start.longitude);
    const startLatitude = this.toRadians(start.latitude);
    const endLatitude = this.toRadians(end.latitude);
    const haversine =
      Math.sin(latitudeDelta / 2) ** 2 +
      Math.cos(startLatitude) *
        Math.cos(endLatitude) *
        Math.sin(longitudeDelta / 2) ** 2;

    return (
      2 *
      earthRadiusMetres *
      Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
    );
  }

  private toRadians(value: number) {
    return (value * Math.PI) / 180;
  }

  private toProviderErrorMessage(provider: string, error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return `${provider}: ${message}`;
  }

  private setSnappedRouteCache(cacheKey: string, response: SnappedRouteResponse) {
    snappedRouteCache.set(cacheKey, {
      expiresAt: Date.now() + ROUTE_CACHE_TTL_MS,
      response,
    });

    while (snappedRouteCache.size > MAX_ROUTE_CACHE_ENTRIES) {
      const oldestKey = snappedRouteCache.keys().next().value;
      if (!oldestKey) {
        return;
      }
      snappedRouteCache.delete(oldestKey);
    }
  }

  private buildAddressCandidates(input: {
    formData: Record<string, unknown>;
    stop: Record<string, unknown> | null;
    location: Record<string, unknown> | null | undefined;
    snapshot: Record<string, unknown> | null | undefined;
    kind: 'pickup' | 'destination';
  }) {
    const rawCandidates = [
      [
        input.location?.name,
        input.location?.addressLine1,
        input.location?.addressLine2,
        input.location?.city,
        input.location?.state,
        input.location?.postalCode,
        input.location?.country,
      ],
      [
        input.stop?.locationName,
        input.stop?.addressLine1,
        input.stop?.addressLine2,
        input.stop?.city,
        input.stop?.state,
        input.stop?.postalCode,
        input.stop?.country,
      ],
      [
        input.snapshot?.name,
        input.snapshot?.addressLine1,
        input.snapshot?.addressLine2,
        input.snapshot?.city,
        input.snapshot?.state,
        input.snapshot?.postalCode,
        input.snapshot?.country,
      ],
      [
        input.formData[
          input.kind === 'pickup' ? 'originName' : 'destinationName'
        ],
        input.formData[
          input.kind === 'pickup' ? 'originAddress' : 'deliveryAddress'
        ],
        input.formData[
          input.kind === 'pickup' ? 'originCity' : 'destinationCity'
        ],
        input.formData[
          input.kind === 'pickup' ? 'originState' : 'destinationState'
        ],
        input.formData[
          input.kind === 'pickup' ? 'originPincode' : 'destinationPincode'
        ],
        input.formData[
          input.kind === 'pickup' ? 'originCountry' : 'destinationCountry'
        ],
      ],
    ];

    return [...new Set(
      rawCandidates
        .map((parts) =>
          parts
            .map((part) => String(part || '').trim())
            .filter(Boolean)
            .join(', '),
        )
        .filter(Boolean)
        .map((candidate) =>
          /\bindia\b/i.test(candidate) ? candidate : `${candidate}, India`,
        ),
    )];
  }

  private async geocodeAddress(address: string): Promise<Coordinate | null> {
    const normalizedAddress = address.trim();
    if (!normalizedAddress) {
      return null;
    }

    if (geocodeCache.has(normalizedAddress)) {
      return geocodeCache.get(normalizedAddress) ?? null;
    }

    try {
      const googleApiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
      const coordinate = googleApiKey
        ? await this.geocodeWithGoogle(normalizedAddress, googleApiKey)
        : await this.geocodeWithNominatim(normalizedAddress);

      geocodeCache.set(normalizedAddress, coordinate);
      return coordinate;
    } catch {
      geocodeCache.set(normalizedAddress, null);
      return null;
    }
  }

  private async geocodeWithGoogle(
    address: string,
    apiKey: string,
  ): Promise<Coordinate | null> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', address);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('region', 'in');

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      results?: Array<{
        geometry?: { location?: { lat?: number; lng?: number } };
      }>;
      status?: string;
    };

    if (payload.status !== 'OK') {
      return null;
    }

    const latitude = Number(payload.results?.[0]?.geometry?.location?.lat);
    const longitude = Number(payload.results?.[0]?.geometry?.location?.lng);

    return this.firstValidCoordinate([latitude, longitude]);
  }

  private async geocodeWithNominatim(address: string): Promise<Coordinate | null> {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    url.searchParams.set('countrycodes', 'in');
    url.searchParams.set('q', address);

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'AshwaLogix/1.0 shipment-coordinate-resolver',
      },
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as Array<{
      lat?: string;
      lon?: string;
    }>;

    const latitude = Number(payload?.[0]?.lat);
    const longitude = Number(payload?.[0]?.lon);

    return this.firstValidCoordinate([latitude, longitude]);
  }

  private async reverseGeocodeWithGoogle(
    coordinate: Coordinate,
    apiKey: string,
  ): Promise<string | null> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('latlng', `${coordinate.latitude},${coordinate.longitude}`);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('region', 'in');

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      results?: Array<{ formatted_address?: string }>;
      status?: string;
    };

    if (payload.status !== 'OK') {
      return null;
    }

    return payload.results?.[0]?.formatted_address?.trim() || null;
  }

  private async reverseGeocodeWithNominatim(
    coordinate: Coordinate,
  ): Promise<string | null> {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(coordinate.latitude));
    url.searchParams.set('lon', String(coordinate.longitude));

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'AshwaLogix/1.0 shipment-reverse-geocoder',
      },
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      display_name?: string;
    };

    return payload.display_name?.trim() || null;
  }

  private mapCompanyClient<
    T extends { companyClientCode?: string } | null | undefined,
  >(
    companyClient: T,
  ) {
    if (!companyClient) {
      return null;
    }

    const { companyClientCode, ...rest } = companyClient;

    return {
      ...rest,
      companyClientCode: companyClientCode ?? null,
    };
  }

  private toOrderEventMessage(input: {
    organizationId: string;
    shipmentId: string;
    eventType: string;
    notes?: string | null;
    fromStatus?: ShipmentStatus | null;
    toStatus?: ShipmentStatus | null;
    metadata?: Prisma.InputJsonValue;
  }): OrderEventMessage {
    return {
      eventId: randomUUID(),
      shipmentId: input.shipmentId,
      organizationId: input.organizationId,
      eventType: input.eventType,
      notes: input.notes ?? null,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      eventTime: new Date().toISOString(),
      metadata: input.metadata,
    };
  }

  private async publishOrderEventSafe(event: OrderEventMessage) {
    await this.trackingEventBus.publishOrderEvent(event);
  }
}
