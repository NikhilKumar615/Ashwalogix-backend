import { BadRequestException, Injectable } from '@nestjs/common';
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
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AssignDriverDto } from './dto/assign-driver.dto';
import { CreateShipmentDto } from './dto/create-shipment.dto';
import { CreateProofOfDeliveryDto } from './dto/create-proof-of-delivery.dto';
import { CreateTrackingPointDto } from './dto/create-tracking-point.dto';
import { FailShipmentDto } from './dto/fail-shipment.dto';
import { ShipmentStatusActionDto } from './dto/shipment-status-action.dto';
import { StartTrackingSessionDto } from './dto/start-tracking-session.dto';

type ListShipmentsParams = {
  organizationId?: string;
  organizationIds?: string[];
  status?: ShipmentStatus;
};

@Injectable()
export class ShipmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async listShipments(params: ListShipmentsParams) {
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
    const shipmentCode = input.shipmentCode ?? this.generateShipmentCode();
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

  async assignDriver(shipmentId: string, input: AssignDriverDto) {
    const shipment = await this.ensureShipmentExists(shipmentId);
    await this.ensureDriverExists(input.driverId, input.organizationId);

    if (input.vehicleId) {
      await this.ensureVehicleExists(input.vehicleId, input.organizationId);
    }

    return this.prisma.$transaction(async (tx) => {
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

      await tx.shipmentStatusEvent.create({
        data: {
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
        },
      });

      return assignment;
    });
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

    return this.prisma.$transaction(async (tx) => {
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

      await tx.shipmentStatusEvent.create({
        data: {
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
        },
      });

      return trackingSession;
    });
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

    return this.prisma.$transaction(async (tx) => {
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

      await tx.shipmentStatusEvent.create({
        data: {
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
        },
      });

      return proof;
    });
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

  private generateShipmentCode() {
    const today = new Date();
    const y = today.getUTCFullYear();
    const m = String(today.getUTCMonth() + 1).padStart(2, '0');
    const d = String(today.getUTCDate()).padStart(2, '0');

    return `SHP-${y}${m}${d}-${randomUUID().slice(0, 8).toUpperCase()}`;
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

    return this.prisma.$transaction(async (tx) => {
      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          status: nextStatus,
        },
      });

      if (afterUpdate) {
        await afterUpdate(tx);
      }

      await tx.shipmentStatusEvent.create({
        data: {
          organizationId,
          shipmentId,
          eventType: eventTypes[0],
          fromStatus: shipment.status,
          toStatus: nextStatus,
          source: EventSource.API,
          notes,
          metadata,
        },
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

      return shipmentDetails
        ? this.mapShipmentCompanyClient(shipmentDetails)
        : null;
    });
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
}
