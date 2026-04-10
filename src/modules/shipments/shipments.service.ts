import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
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

    return shipments.map((shipment) => this.mapShipmentCompanyClient(shipment));
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
          orderBy: { capturedAt: 'desc' },
        },
      },
    });

    return shipment ? this.mapShipmentCompanyClient(shipment) : null;
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

    const status = input.initialStatus ?? ShipmentStatus.DRAFT;
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

    return this.mapShipmentCompanyClient(shipment);
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

    return this.mapShipmentCompanyClient(shipment);
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
        shipment.status === ShipmentStatus.DRAFT
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
      limit && Number.isFinite(limit)
        ? Math.min(Math.max(Number(limit), 1), 500)
        : 100;

    return this.prisma.trackingPoint.findMany({
      where: { shipmentId },
      orderBy: { recordedAt: 'desc' },
      take: safeLimit,
    });
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
    return this.transitionShipmentStatus(
      shipmentId,
      input.organizationId,
      ShipmentStatus.PLANNED,
      ['shipment_planned'],
      [ShipmentStatus.DRAFT],
      input.notes ?? 'Shipment planned',
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
          ? this.mapShipmentCompanyClient(shipmentDetails)
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
