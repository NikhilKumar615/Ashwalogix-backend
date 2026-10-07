import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  DocumentEntityType,
  DocumentStatus,
  EventSource,
  MembershipStatus,
  ProofType,
  Prisma,
  ShipmentMode,
  ShipmentPriority,
  ShipmentAssignmentStatus,
  ShipmentStatus,
  ShipmentType,
  StopType,
  StopStatus,
  TrackingSessionStatus,
  UserStatus,
  DriverStatus,
  VehicleStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { TRACKING_EVENT_BUS } from '../../shared/kafka/kafka.constants';
import type {
  OrderEventMessage,
  TrackingEventBus,
} from '../../shared/kafka/interfaces/tracking-event-bus.interface';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { DriverRealtimeService } from '../driver-realtime/driver-realtime.service';
import {
  buildBusinessPrefix,
  formatRollingAlphaCode,
  isUniqueConstraintViolation,
  parseRollingAlphaCodeSequence,
  withUniqueCodeRetry,
} from '../../shared/codes/entity-code.util';
import { AssignDriverDto } from './dto/assign-driver.dto';
import {
  CreateShipmentDto,
  CreateShipmentItemDto,
  CreateShipmentStopDto,
} from './dto/create-shipment.dto';
import { CreateProofOfDeliveryDto } from './dto/create-proof-of-delivery.dto';
import { CreateTrackingPointDto } from './dto/create-tracking-point.dto';
import { FailShipmentDto } from './dto/fail-shipment.dto';
import { ManualShipmentStatusDto } from './dto/manual-shipment-status.dto';
import { ShipmentStatusActionDto } from './dto/shipment-status-action.dto';
import { StartTrackingSessionDto } from './dto/start-tracking-session.dto';
import { UpdateShipmentDto } from './dto/update-shipment.dto';
import { ValidateShipmentLocationDto } from './dto/validate-shipment-location.dto';
import { BoundedTtlCache, GEOCODE_FETCH_TIMEOUT_MS } from './geocoding.util';

type ListShipmentsParams = {
  organizationId?: string;
  organizationIds?: string[];
  status?: ShipmentStatus;
  take?: number;
  skip?: number;
  cursor?: string;
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

type RouteSide = 'PICKUP' | 'DELIVERY';

type ExistingStop = {
  id: string;
  stopSequence: number;
  stopType: StopType;
  locationName: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  plannedArrivalAt: Date | null;
  plannedDepartureAt: Date | null;
};

type ExistingItem = {
  id: string;
  description: string;
  quantity: Prisma.Decimal;
  unit: string;
  weight: Prisma.Decimal | null;
  volume: Prisma.Decimal | null;
  declaredValue: Prisma.Decimal | null;
};

type StopChangePlan = {
  locationChanged: boolean;
  pickupChanged: boolean;
  deliveryChanged: boolean;
};

type ItemChangePlan = 'unchanged' | 'details' | 'replace';

type TransitionOptions = {
  shipmentId: string;
  organizationId: string;
  nextStatus: ShipmentStatus;
  eventType: string;
  allowedFromStatuses: ShipmentStatus[];
  notes?: string | null;
  actorUserId?: string | null;
  source?: EventSource;
  /** Extra columns written atomically with the guarded status change. */
  extraData?: Prisma.ShipmentUncheckedUpdateManyInput;
  afterUpdate?: (tx: Prisma.TransactionClient) => Promise<void>;
  metadata?: Prisma.InputJsonValue;
};

const OSRM_MATCH_BASE_URL = 'https://router.project-osrm.org/match/v1/driving';
const OSRM_ROUTE_BASE_URL = 'https://router.project-osrm.org/route/v1/driving';
const GOOGLE_DIRECTIONS_BASE_URL =
  'https://maps.googleapis.com/maps/api/directions/json';
const GOOGLE_ROADS_SNAP_BASE_URL =
  'https://roads.googleapis.com/v1/snapToRoads';
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
const MAX_SNAPPED_ROUTE_SOURCE_POINTS = 5000;

const DEFAULT_LIST_TAKE = 500;
const MAX_LIST_TAKE = 1000;
const DEFAULT_TRACKING_HISTORY_LIMIT = 2000;
const MAX_TRACKING_HISTORY_LIMIT = 10000;
const ORDER_EVENT_PUBLISH_TIMEOUT_MS = 5_000;
// Exceptions (timeouts, network errors) are cached briefly so a flapping
// provider is not hammered, without blocking a retry for long.
const GEOCODE_ERROR_TTL_MS = 60 * 1000;

const TERMINAL_SHIPMENT_STATUSES: ShipmentStatus[] = [
  ShipmentStatus.DELIVERED,
  ShipmentStatus.COMPLETED,
  ShipmentStatus.FAILED,
  ShipmentStatus.CANCELLED,
];

// Route (client, locations, stops, items, mode/type) may only change before
// the driver is on the way.
const ROUTE_EDITABLE_STATUSES: ShipmentStatus[] = [
  ShipmentStatus.DRAFT,
  ShipmentStatus.PLANNED,
  ShipmentStatus.ASSIGNED,
];

const ASSIGNABLE_STATUSES: ShipmentStatus[] = [
  ShipmentStatus.DRAFT,
  ShipmentStatus.PLANNED,
  ShipmentStatus.ASSIGNED,
  ShipmentStatus.EN_ROUTE_PICKUP,
];

const CANCELLABLE_STATUSES: ShipmentStatus[] = [
  ShipmentStatus.DRAFT,
  ShipmentStatus.PLANNED,
  ShipmentStatus.ASSIGNED,
  ShipmentStatus.EN_ROUTE_PICKUP,
  ShipmentStatus.AT_PICKUP,
];

const FAILABLE_STATUSES: ShipmentStatus[] = [
  ShipmentStatus.ASSIGNED,
  ShipmentStatus.EN_ROUTE_PICKUP,
  ShipmentStatus.AT_PICKUP,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.AT_DELIVERY,
];

const PROOF_ALLOWED_STATUSES: Record<ProofType, ShipmentStatus[]> = {
  [ProofType.PICKUP]: [ShipmentStatus.AT_PICKUP],
  [ProofType.DELIVERY]: [ShipmentStatus.AT_DELIVERY, ShipmentStatus.DELIVERED],
};

// Admin "manual status" endpoint: explicit, forward-only transitions. POD and
// driver preconditions are still enforced in manuallyUpdateShipmentStatus.
const MANUAL_STATUS_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  [ShipmentStatus.DRAFT]: [
    ShipmentStatus.PLANNED,
    ShipmentStatus.ASSIGNED,
    ShipmentStatus.CANCELLED,
  ],
  [ShipmentStatus.PLANNED]: [ShipmentStatus.ASSIGNED, ShipmentStatus.CANCELLED],
  [ShipmentStatus.ASSIGNED]: [
    ShipmentStatus.EN_ROUTE_PICKUP,
    ShipmentStatus.AT_PICKUP,
    ShipmentStatus.CANCELLED,
    ShipmentStatus.FAILED,
  ],
  [ShipmentStatus.EN_ROUTE_PICKUP]: [
    ShipmentStatus.AT_PICKUP,
    ShipmentStatus.CANCELLED,
    ShipmentStatus.FAILED,
  ],
  [ShipmentStatus.AT_PICKUP]: [
    ShipmentStatus.PICKED_UP,
    ShipmentStatus.CANCELLED,
    ShipmentStatus.FAILED,
  ],
  [ShipmentStatus.PICKED_UP]: [
    ShipmentStatus.IN_TRANSIT,
    ShipmentStatus.AT_DELIVERY,
    ShipmentStatus.FAILED,
  ],
  [ShipmentStatus.IN_TRANSIT]: [
    ShipmentStatus.AT_DELIVERY,
    ShipmentStatus.FAILED,
  ],
  [ShipmentStatus.AT_DELIVERY]: [
    ShipmentStatus.DELIVERED,
    ShipmentStatus.FAILED,
  ],
  [ShipmentStatus.DELIVERED]: [ShipmentStatus.COMPLETED],
  [ShipmentStatus.COMPLETED]: [],
  [ShipmentStatus.FAILED]: [],
  [ShipmentStatus.CANCELLED]: [],
};

const DRIVER_REQUIRED_STATUSES: ShipmentStatus[] = [
  ShipmentStatus.ASSIGNED,
  ShipmentStatus.EN_ROUTE_PICKUP,
  ShipmentStatus.AT_PICKUP,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.AT_DELIVERY,
  ShipmentStatus.DELIVERED,
];

// adminFormData keys that describe the route. They are frozen once the
// shipment is past ASSIGNED.
const ROUTE_FORM_KEYS = [
  'originName',
  'originAddress',
  'originCity',
  'originState',
  'originPincode',
  'originCountry',
  'originLatitude',
  'originLongitude',
  'pickupLatitude',
  'pickupLongitude',
  'pickupLocationVerifiedAt',
  'destinationName',
  'deliveryAddress',
  'destinationCity',
  'destinationState',
  'destinationPincode',
  'destinationCountry',
  'destinationLatitude',
  'destinationLongitude',
  'receiverLatitude',
  'receiverLongitude',
  'deliveryLocationVerifiedAt',
];

const ROUTE_ADDRESS_FORM_KEYS: Record<RouteSide, string[]> = {
  PICKUP: [
    'originName',
    'originAddress',
    'originCity',
    'originState',
    'originPincode',
  ],
  DELIVERY: [
    'destinationName',
    'deliveryAddress',
    'destinationCity',
    'destinationState',
    'destinationPincode',
  ],
};

const ROUTE_COORDINATE_FORM_KEYS: Record<
  RouteSide,
  { latitude: string; longitude: string; verifiedAt: string }
> = {
  PICKUP: {
    latitude: 'originLatitude',
    longitude: 'originLongitude',
    verifiedAt: 'pickupLocationVerifiedAt',
  },
  DELIVERY: {
    latitude: 'destinationLatitude',
    longitude: 'destinationLongitude',
    verifiedAt: 'deliveryLocationVerifiedAt',
  },
};

const SHIPMENT_DETAIL_INCLUDE = {
  companyClient: true,
  sourceLocation: true,
  destinationLocation: true,
  currentDriver: true,
  currentVehicle: true,
  items: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
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
} satisfies Prisma.ShipmentInclude;

const geocodeCache = new BoundedTtlCache<Coordinate | null>();

/** String form of a primitive form/DB value; objects and nullish become ''. */
function textOf(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Prisma.Decimal) {
    return value.toString();
  }
  return '';
}
const reverseGeocodeCache = new BoundedTtlCache<string | null>();
const snappedRouteCache = new Map<string, SnappedRouteCacheEntry>();

@Injectable()
export class ShipmentsService {
  private readonly logger = new Logger(ShipmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly driverRealtimeService: DriverRealtimeService,
    @Inject(TRACKING_EVENT_BUS)
    private readonly trackingEventBus: TrackingEventBus,
  ) {}

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

    const take = this.clampInteger(
      params.take,
      DEFAULT_LIST_TAKE,
      1,
      MAX_LIST_TAKE,
    );
    const skip = this.clampInteger(
      params.skip,
      params.cursor ? 1 : 0,
      0,
      Number.MAX_SAFE_INTEGER,
    );

    const shipments = await this.prisma.shipment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      skip,
      ...(params.cursor ? { cursor: { id: params.cursor } } : {}),
      include: {
        companyClient: true,
        currentDriver: true,
        currentVehicle: true,
      },
    });

    // List rows only use coordinates that are already stored (adminFormData,
    // address snapshots); geocoding is reserved for the detail endpoint.
    return shipments.map((shipment) =>
      this.toStoredCoordinateResponse(shipment),
    );
  }

  async getShipmentById(id: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
      include: SHIPMENT_DETAIL_INCLUDE,
    });

    return shipment ? this.enrichShipmentCoordinates(shipment) : null;
  }

  /**
   * Looks a shipment up by code, restricted to the caller's organizations.
   * `organizationIds === null` means unrestricted (platform super admin).
   */
  async getShipmentByCode(
    shipmentCode: string,
    organizationIds: string[] | null,
  ) {
    const normalizedCode = shipmentCode.trim().toUpperCase();

    if (
      !normalizedCode ||
      (organizationIds !== null && !organizationIds.length)
    ) {
      return null;
    }

    const shipment = await this.prisma.shipment.findFirst({
      where: {
        shipmentCode: normalizedCode,
        ...(organizationIds !== null
          ? { organizationId: { in: organizationIds } }
          : {}),
      },
      include: SHIPMENT_DETAIL_INCLUDE,
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

  async createShipment(input: CreateShipmentDto, actorUserId?: string | null) {
    this.validateCreateShipmentInput(input);
    this.validatePlannedDates(input.plannedPickupAt, input.plannedDeliveryAt);
    this.assertUniqueStopSequences(input.stops);
    await this.assertCompanyClientBelongsToOrganization(
      input.organizationId,
      input.companyClientId,
    );
    await this.assertShipmentLocationsBelongToOrganization(input);
    await this.normalizeRequiredRouteCoordinates(input);
    const snapshots = await this.buildAddressSnapshots(input);

    const status = ShipmentStatus.DRAFT;
    const requestedShipmentCode = input.shipmentCode?.trim().toUpperCase();

    if (requestedShipmentCode) {
      const existingShipment = await this.prisma.shipment.findUnique({
        where: {
          organizationId_shipmentCode: {
            organizationId: input.organizationId,
            shipmentCode: requestedShipmentCode,
          },
        },
        select: { id: true },
      });

      if (existingShipment) {
        throw new BadRequestException(
          `Shipment code ${requestedShipmentCode} already exists`,
        );
      }
    }

    const createWithCode = (shipmentCode: string) =>
      this.prisma.shipment.create({
        data: {
          organizationId: input.organizationId,
          companyClientId: input.companyClientId,
          shipmentMode: input.shipmentMode,
          shipmentCode,
          shipmentType: input.shipmentType,
          priority: input.priority ?? ShipmentPriority.MEDIUM,
          status,
          sourceLocationId: input.sourceLocationId,
          destinationLocationId: input.destinationLocationId,
          sourceAddressSnapshot: snapshots.source ?? undefined,
          destinationAddressSnapshot: snapshots.destination ?? undefined,
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
                create: input.items.map((item) =>
                  this.toItemCreateData(input.organizationId, item),
                ),
              }
            : undefined,
          stops: input.stops?.length
            ? {
                create: input.stops.map((stop) =>
                  this.toStopCreateData(input.organizationId, stop),
                ),
              }
            : undefined,
          statusEvents: {
            create: {
              organizationId: input.organizationId,
              actorUserId: actorUserId ?? undefined,
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
          items: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
          stops: {
            orderBy: { stopSequence: 'asc' },
          },
          statusEvents: {
            orderBy: { eventTime: 'desc' },
          },
        },
      });

    let shipment: Awaited<ReturnType<typeof createWithCode>>;
    try {
      shipment = requestedShipmentCode
        ? await createWithCode(requestedShipmentCode)
        : await withUniqueCodeRetry(
            async () =>
              createWithCode(
                await this.generateShipmentCode(input.organizationId),
              ),
            {
              // Only retry when the collision is on the generated code, not
              // on a duplicate invoice number.
              shouldRetry: async () =>
                !(await this.isInvoiceNumberTaken(
                  input.organizationId,
                  input.invoiceNumber,
                )),
            },
          );
    } catch (error) {
      return this.rethrowUniqueViolation(
        error,
        input.organizationId,
        input.invoiceNumber,
      );
    }

    const enrichedShipment = await this.enrichShipmentCoordinates(shipment);
    void this.sendShipmentUpdateEmail(
      shipment,
      'Shipment created',
      'A new shipment has been created and is ready for planning.',
    );
    return enrichedShipment;
  }

  async updateShipment(
    shipmentId: string,
    input: UpdateShipmentDto,
    actorUserId?: string | null,
  ) {
    const existingShipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: {
        stops: { orderBy: { stopSequence: 'asc' } },
        items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });

    if (!existingShipment) {
      throw new BadRequestException(`Shipment ${shipmentId} does not exist`);
    }

    if (
      input.organizationId &&
      input.organizationId !== existingShipment.organizationId
    ) {
      throw new BadRequestException(
        'organizationId does not match the shipment organization',
      );
    }

    // Status changes only go through the guarded status actions.
    if (
      input.initialStatus !== undefined &&
      input.initialStatus !== existingShipment.status
    ) {
      throw new BadRequestException(
        'Shipment status cannot be changed through an update. Use the shipment status actions instead.',
      );
    }

    const organizationId = existingShipment.organizationId;
    const routeLocked = !ROUTE_EDITABLE_STATUSES.includes(
      existingShipment.status,
    );
    const existingFormData = this.asRecord(existingShipment.adminFormData);
    const requestedShipmentCode = input.shipmentCode?.trim().toUpperCase();

    const normalizedInput: CreateShipmentDto = {
      organizationId,
      shipmentMode: input.shipmentMode ?? existingShipment.shipmentMode,
      shipmentType: input.shipmentType ?? existingShipment.shipmentType,
      priority: input.priority ?? existingShipment.priority ?? undefined,
      // Codes are stable: only an explicit, different code changes it (a
      // re-submitted code that differs only by case is ignored).
      shipmentCode:
        requestedShipmentCode &&
        requestedShipmentCode !== existingShipment.shipmentCode.toUpperCase()
          ? requestedShipmentCode
          : existingShipment.shipmentCode,
      companyClientId:
        input.shipmentMode === ShipmentMode.INTERNAL
          ? undefined
          : input.companyClientId !== undefined
            ? input.companyClientId
            : (existingShipment.companyClientId ?? undefined),
      sourceLocationId:
        input.sourceLocationId !== undefined
          ? input.sourceLocationId
          : (existingShipment.sourceLocationId ?? undefined),
      destinationLocationId:
        input.destinationLocationId !== undefined
          ? input.destinationLocationId
          : (existingShipment.destinationLocationId ?? undefined),
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
          : (existingShipment.invoiceNumber ?? undefined),
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
          : (existingShipment.internalSenderName ?? undefined),
      internalSenderPhone:
        input.internalSenderPhone !== undefined
          ? input.internalSenderPhone
          : (existingShipment.internalSenderPhone ?? undefined),
      internalSenderDepartment:
        input.internalSenderDepartment !== undefined
          ? input.internalSenderDepartment
          : (existingShipment.internalSenderDepartment ?? undefined),
      internalReceiverName:
        input.internalReceiverName !== undefined
          ? input.internalReceiverName
          : (existingShipment.internalReceiverName ?? undefined),
      internalReceiverPhone:
        input.internalReceiverPhone !== undefined
          ? input.internalReceiverPhone
          : (existingShipment.internalReceiverPhone ?? undefined),
      internalReceiverDepartment:
        input.internalReceiverDepartment !== undefined
          ? input.internalReceiverDepartment
          : (existingShipment.internalReceiverDepartment ?? undefined),
      notes:
        input.notes !== undefined
          ? input.notes
          : (existingShipment.notes ?? undefined),
      adminFormData:
        input.adminFormData !== undefined
          ? input.adminFormData
          : Object.keys(existingFormData).length ||
              existingShipment.adminFormData
            ? existingFormData
            : undefined,
      items: input.items,
      stops: input.stops,
      eventSource: input.eventSource ?? EventSource.API,
    };

    this.validateCreateShipmentInput(normalizedInput);
    if (
      input.plannedPickupAt !== undefined ||
      input.plannedDeliveryAt !== undefined
    ) {
      this.validatePlannedDates(
        normalizedInput.plannedPickupAt,
        normalizedInput.plannedDeliveryAt,
      );
    }
    this.assertUniqueStopSequences(input.stops);

    const stopPlan =
      input.stops !== undefined
        ? this.planStopChanges(existingShipment.stops, input.stops)
        : null;
    const itemPlan =
      input.items !== undefined
        ? this.planItemChanges(existingShipment.items, input.items)
        : null;

    const companyClientChanged =
      (normalizedInput.companyClientId ?? null) !==
      (existingShipment.companyClientId ?? null);
    const sourceLocationChanged =
      (normalizedInput.sourceLocationId ?? null) !==
      (existingShipment.sourceLocationId ?? null);
    const destinationLocationChanged =
      (normalizedInput.destinationLocationId ?? null) !==
      (existingShipment.destinationLocationId ?? null);

    if (routeLocked) {
      const lockedChanges: string[] = [];
      if (normalizedInput.shipmentMode !== existingShipment.shipmentMode) {
        lockedChanges.push('shipmentMode');
      }
      if (normalizedInput.shipmentType !== existingShipment.shipmentType) {
        lockedChanges.push('shipmentType');
      }
      if (companyClientChanged) lockedChanges.push('companyClientId');
      if (sourceLocationChanged) lockedChanges.push('sourceLocationId');
      if (destinationLocationChanged)
        lockedChanges.push('destinationLocationId');
      if (stopPlan?.locationChanged) lockedChanges.push('stops');
      if (itemPlan === 'replace') lockedChanges.push('items');

      if (lockedChanges.length) {
        throw new ConflictException(
          `${lockedChanges.join(', ')} cannot be changed once the shipment is ${existingShipment.status}.`,
        );
      }

      // Route keys inside adminFormData (addresses, pins) are frozen too.
      if (input.adminFormData !== undefined) {
        normalizedInput.adminFormData = this.preserveRouteFormKeys(
          existingFormData,
          input.adminFormData,
        );
      }
    }

    if (companyClientChanged) {
      await this.assertCompanyClientBelongsToOrganization(
        organizationId,
        normalizedInput.companyClientId,
      );
    }
    await this.assertShipmentLocationsBelongToOrganization(normalizedInput);

    if (
      normalizedInput.shipmentCode !== existingShipment.shipmentCode &&
      normalizedInput.shipmentCode
    ) {
      const codeOwner = await this.prisma.shipment.findUnique({
        where: {
          organizationId_shipmentCode: {
            organizationId,
            shipmentCode: normalizedInput.shipmentCode,
          },
        },
        select: { id: true },
      });
      if (codeOwner && codeOwner.id !== shipmentId) {
        throw new ConflictException(
          `Shipment code ${normalizedInput.shipmentCode} already exists`,
        );
      }
    }

    // Route coordinates: only re-geocode the side whose address changed, keep
    // user-pinned/verified coordinates otherwise. Runs before (never inside)
    // the transaction.
    let snapshotUpdate: {
      source: Prisma.InputJsonValue | null;
      destination: Prisma.InputJsonValue | null;
    } | null = null;

    if (!routeLocked) {
      const routeInput: CreateShipmentDto = {
        ...normalizedInput,
        stops:
          input.stops ??
          existingShipment.stops.map((stop) => this.toStopDto(stop)),
      };
      const pickupChanged =
        Boolean(stopPlan?.pickupChanged) ||
        sourceLocationChanged ||
        this.routeFormAddressChanged(
          existingFormData,
          input.adminFormData,
          'PICKUP',
        );
      const deliveryChanged =
        Boolean(stopPlan?.deliveryChanged) ||
        destinationLocationChanged ||
        this.routeFormAddressChanged(
          existingFormData,
          input.adminFormData,
          'DELIVERY',
        );

      await this.resolveRouteCoordinatesForUpdate(
        routeInput,
        existingFormData,
        {
          PICKUP: pickupChanged,
          DELIVERY: deliveryChanged,
        },
      );
      normalizedInput.adminFormData = routeInput.adminFormData;

      if (pickupChanged || deliveryChanged) {
        snapshotUpdate = await this.buildAddressSnapshots(routeInput);
      }
    }

    let shipment;
    try {
      shipment = await this.prisma.$transaction(async (tx) => {
        const guard = await tx.shipment.updateMany({
          where: { id: shipmentId, status: existingShipment.status },
          data: {
            companyClientId: normalizedInput.companyClientId ?? null,
            shipmentMode: normalizedInput.shipmentMode,
            shipmentCode: normalizedInput.shipmentCode,
            shipmentType: normalizedInput.shipmentType,
            priority: normalizedInput.priority ?? ShipmentPriority.MEDIUM,
            sourceLocationId: normalizedInput.sourceLocationId ?? null,
            destinationLocationId:
              normalizedInput.destinationLocationId ?? null,
            ...(snapshotUpdate
              ? {
                  sourceAddressSnapshot: snapshotUpdate.source ?? Prisma.DbNull,
                  destinationAddressSnapshot:
                    snapshotUpdate.destination ?? Prisma.DbNull,
                }
              : {}),
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
            internalReceiverPhone:
              normalizedInput.internalReceiverPhone ?? null,
            internalReceiverDepartment:
              normalizedInput.internalReceiverDepartment ?? null,
            notes: normalizedInput.notes ?? null,
            adminFormData:
              normalizedInput.adminFormData !== undefined
                ? (normalizedInput.adminFormData as Prisma.InputJsonValue)
                : Prisma.DbNull,
          },
        });

        if (guard.count === 0) {
          throw new ConflictException(
            'The shipment status changed while saving. Reload the shipment and try again.',
          );
        }

        if (input.items !== undefined && itemPlan && itemPlan !== 'unchanged') {
          await this.applyItemChanges(
            tx,
            shipmentId,
            organizationId,
            existingShipment.items,
            input.items,
            itemPlan,
          );
        }

        if (input.stops !== undefined) {
          await this.applyStopChanges(
            tx,
            shipmentId,
            organizationId,
            existingShipment.stops,
            input.stops,
          );
        }

        await tx.shipmentStatusEvent.create({
          data: {
            organizationId,
            shipmentId,
            actorUserId: actorUserId ?? undefined,
            eventType: 'shipment_updated',
            fromStatus: existingShipment.status,
            toStatus: existingShipment.status,
            source: normalizedInput.eventSource ?? EventSource.API,
            notes: 'Shipment updated via API',
            metadata: {
              shipmentMode: normalizedInput.shipmentMode,
              shipmentType: normalizedInput.shipmentType,
              priority: normalizedInput.priority ?? ShipmentPriority.MEDIUM,
              itemsChanged: Boolean(itemPlan && itemPlan !== 'unchanged'),
              stopsChanged: Boolean(stopPlan?.locationChanged),
            },
          },
        });

        return tx.shipment.findUniqueOrThrow({
          where: { id: shipmentId },
          include: SHIPMENT_DETAIL_INCLUDE,
        });
      });
    } catch (error) {
      return this.rethrowUniqueViolation(
        error,
        organizationId,
        normalizedInput.invoiceNumber,
        shipmentId,
      );
    }

    const enrichedShipment = await this.enrichShipmentCoordinates(shipment);
    this.driverRealtimeService.notifyShipmentChange(shipment.currentDriverId, {
      shipmentId,
      organizationId,
      change: 'updated',
    });
    return enrichedShipment;
  }

  async assignDriver(
    shipmentId: string,
    input: AssignDriverDto,
    actorUserId?: string | null,
  ) {
    const shipment = await this.ensureShipmentExists(shipmentId);

    if (shipment.organizationId !== input.organizationId) {
      throw new BadRequestException(
        'organizationId does not match the shipment organization',
      );
    }

    const requestedVehicleId = input.vehicleId ?? null;
    const activeAssignment = await this.prisma.shipmentAssignment.findFirst({
      where: {
        shipmentId,
        assignmentStatus: ShipmentAssignmentStatus.ACTIVE,
      },
      include: {
        driver: true,
        vehicle: true,
      },
      orderBy: { assignedAt: 'desc' },
    });

    // Re-submitting the current driver/vehicle (e.g. the portal edit form) is
    // a no-op in any status.
    if (
      activeAssignment &&
      activeAssignment.driverId === input.driverId &&
      (activeAssignment.vehicleId ?? null) === requestedVehicleId &&
      shipment.currentDriverId === input.driverId &&
      (shipment.currentVehicleId ?? null) === requestedVehicleId
    ) {
      return activeAssignment;
    }

    if (!ASSIGNABLE_STATUSES.includes(shipment.status)) {
      throw new ConflictException(
        `A driver cannot be assigned while the shipment is ${shipment.status}.`,
      );
    }

    const driver = await this.ensureDriverExists(
      input.driverId,
      shipment.organizationId,
    );
    if (driver.status !== DriverStatus.ACTIVE) {
      throw new BadRequestException(
        `Driver ${driver.fullName} is ${driver.status} and cannot be assigned.`,
      );
    }

    if (requestedVehicleId) {
      const vehicle = await this.ensureVehicleExists(
        requestedVehicleId,
        shipment.organizationId,
      );
      if (vehicle.status !== VehicleStatus.ACTIVE) {
        throw new BadRequestException(
          `Vehicle ${vehicle.vehicleNumber} is ${vehicle.status} and cannot be assigned.`,
        );
      }
    }

    const shipmentWithRoute = await this.getShipmentById(shipmentId);

    if (
      !shipmentWithRoute?.resolvedPickupCoordinates ||
      !shipmentWithRoute.resolvedDestinationCoordinates
    ) {
      throw new BadRequestException(
        'A verified pickup and delivery location are required before assigning a driver.',
      );
    }

    const busyDriverShipment = await this.prisma.shipment.findFirst({
      where: {
        id: { not: shipmentId },
        status: { notIn: TERMINAL_SHIPMENT_STATUSES },
        OR: [
          { currentDriverId: input.driverId },
          {
            assignments: {
              some: {
                driverId: input.driverId,
                assignmentStatus: ShipmentAssignmentStatus.ACTIVE,
              },
            },
          },
        ],
      },
      select: { shipmentCode: true },
    });
    if (busyDriverShipment) {
      throw new ConflictException(
        `Driver ${driver.fullName} is already assigned to active shipment ${busyDriverShipment.shipmentCode}.`,
      );
    }

    if (requestedVehicleId) {
      const busyVehicleShipment = await this.prisma.shipment.findFirst({
        where: {
          id: { not: shipmentId },
          status: { notIn: TERMINAL_SHIPMENT_STATUSES },
          OR: [
            { currentVehicleId: requestedVehicleId },
            {
              assignments: {
                some: {
                  vehicleId: requestedVehicleId,
                  assignmentStatus: ShipmentAssignmentStatus.ACTIVE,
                },
              },
            },
          ],
        },
        select: { shipmentCode: true },
      });
      if (busyVehicleShipment) {
        throw new ConflictException(
          `The vehicle is already assigned to active shipment ${busyVehicleShipment.shipmentCode}.`,
        );
      }
    }

    const isDriverChange = Boolean(
      shipment.currentDriverId && shipment.currentDriverId !== input.driverId,
    );
    const nextStatus =
      shipment.status === ShipmentStatus.PLANNED ||
      (isDriverChange && shipment.status === ShipmentStatus.EN_ROUTE_PICKUP)
        ? ShipmentStatus.ASSIGNED
        : shipment.status;

    const result = await this.prisma.$transaction(async (tx) => {
      const guard = await tx.shipment.updateMany({
        where: {
          id: shipmentId,
          organizationId: shipment.organizationId,
          status: shipment.status,
          currentDriverId: shipment.currentDriverId,
        },
        data: {
          currentDriverId: input.driverId,
          currentVehicleId: requestedVehicleId,
          status: nextStatus,
        },
      });

      if (guard.count === 0) {
        throw new ConflictException(
          'The shipment changed while assigning the driver. Reload and try again.',
        );
      }

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

      // The previous driver's live session must not keep feeding this shipment.
      if (isDriverChange) {
        await this.closeTrackingSession(
          tx,
          shipmentId,
          TrackingSessionStatus.CANCELLED,
        );
      }

      const assignment = await tx.shipmentAssignment.create({
        data: {
          organizationId: shipment.organizationId,
          shipmentId,
          driverId: input.driverId,
          vehicleId: requestedVehicleId,
          notes: input.notes,
        },
        include: {
          driver: true,
          vehicle: true,
        },
      });

      const event = {
        organizationId: shipment.organizationId,
        shipmentId,
        driverId: input.driverId,
        actorUserId: actorUserId ?? undefined,
        eventType: 'driver_assigned',
        fromStatus: shipment.status,
        toStatus: nextStatus,
        source: EventSource.API,
        notes: input.notes ?? 'Driver assigned to shipment',
        metadata: {
          vehicleId: requestedVehicleId,
          previousDriverId: shipment.currentDriverId,
          previousVehicleId: shipment.currentVehicleId,
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

    this.publishOrderEventSafe(result.orderEvent);
    this.driverRealtimeService.notifyShipmentChange(input.driverId, {
      shipmentId,
      organizationId: shipment.organizationId,
      change: 'assigned',
    });
    if (isDriverChange) {
      this.driverRealtimeService.notifyShipmentChange(
        shipment.currentDriverId,
        {
          shipmentId,
          organizationId: shipment.organizationId,
          change: 'removed',
        },
      );
    }
    return result.assignment;
  }

  async startTrackingSession(
    shipmentId: string,
    input: StartTrackingSessionDto,
    actorUserId?: string | null,
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

    if (TERMINAL_SHIPMENT_STATUSES.includes(shipment.status)) {
      throw new ConflictException(
        `Tracking cannot start while the shipment is ${shipment.status}.`,
      );
    }

    const existingActiveSession = await this.findActiveSessionForDriver(
      shipment.currentTrackingSessionId,
      shipmentId,
      input.driverId,
    );
    if (existingActiveSession) {
      return existingActiveSession;
    }

    const nextStatus =
      shipment.status === ShipmentStatus.ASSIGNED
        ? ShipmentStatus.EN_ROUTE_PICKUP
        : shipment.status;

    let result: {
      trackingSession: Awaited<
        ReturnType<PrismaService['trackingSession']['create']>
      >;
      orderEvent: OrderEventMessage;
    };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        // Any stale ACTIVE session for this shipment is closed first.
        await tx.trackingSession.updateMany({
          where: { shipmentId, status: TrackingSessionStatus.ACTIVE },
          data: {
            status: TrackingSessionStatus.COMPLETED,
            endedAt: new Date(),
          },
        });

        const trackingSession = await tx.trackingSession.create({
          data: {
            organizationId: input.organizationId,
            shipmentId,
            driverId: input.driverId,
            status: TrackingSessionStatus.ACTIVE,
          },
        });

        const guard = await tx.shipment.updateMany({
          where: {
            id: shipmentId,
            status: shipment.status,
            currentDriverId: input.driverId,
            currentTrackingSessionId: shipment.currentTrackingSessionId,
          },
          data: {
            currentTrackingSessionId: trackingSession.id,
            status: nextStatus,
          },
        });

        if (guard.count === 0) {
          throw new ConflictException(
            'The shipment changed while starting tracking. Reload and try again.',
          );
        }

        const event = {
          organizationId: input.organizationId,
          shipmentId,
          driverId: input.driverId,
          actorUserId: actorUserId ?? undefined,
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
    } catch (error) {
      // A concurrent start from the same driver won the race: return its session.
      if (error instanceof ConflictException) {
        const latest = await this.prisma.shipment.findUnique({
          where: { id: shipmentId },
          select: { currentTrackingSessionId: true },
        });
        const concurrentSession = await this.findActiveSessionForDriver(
          latest?.currentTrackingSessionId ?? null,
          shipmentId,
          input.driverId,
        );
        if (concurrentSession) {
          return concurrentSession;
        }
      }
      throw error;
    }

    this.publishOrderEventSafe(result.orderEvent);
    this.driverRealtimeService.notifyShipmentChange(shipment.currentDriverId, {
      shipmentId,
      organizationId: input.organizationId,
      change: 'status_changed',
    });
    return result.trackingSession;
  }

  async addTrackingPoint(shipmentId: string, input: CreateTrackingPointDto) {
    const shipment = await this.ensureShipmentExists(shipmentId);

    if (shipment.organizationId !== input.organizationId) {
      throw new BadRequestException(
        'organizationId does not match the shipment organization',
      );
    }

    if (
      !shipment.currentDriverId ||
      shipment.currentDriverId !== input.driverId
    ) {
      throw new BadRequestException(
        'The provided driver is not the current driver for this shipment',
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

    if (
      !trackingSession ||
      trackingSession.shipmentId !== shipmentId ||
      trackingSession.organizationId !== shipment.organizationId ||
      trackingSession.driverId !== input.driverId
    ) {
      throw new BadRequestException(
        'Tracking session does not belong to this shipment and driver',
      );
    }

    if (trackingSession.status !== TrackingSessionStatus.ACTIVE) {
      throw new BadRequestException('Tracking session is not active');
    }

    return this.prisma.trackingPoint.create({
      data: {
        organizationId: shipment.organizationId,
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

  async getTrackingHistory(shipmentId: string, limit?: number | string | null) {
    await this.ensureShipmentExists(shipmentId);

    const safeLimit = this.clampInteger(
      limit,
      DEFAULT_TRACKING_HISTORY_LIMIT,
      1,
      MAX_TRACKING_HISTORY_LIMIT,
    );

    // Latest N points, newest first (unchanged ordering).
    return this.prisma.trackingPoint.findMany({
      where: { shipmentId },
      orderBy: { recordedAt: 'desc' },
      take: safeLimit,
    });
  }

  async getSnappedTrackingRoute(
    shipmentId: string,
  ): Promise<SnappedRouteResponse> {
    await this.ensureShipmentExists(shipmentId);

    // Bounded read: the latest N points, then back to chronological order.
    const trackingPoints = (
      await this.prisma.trackingPoint.findMany({
        where: { shipmentId },
        orderBy: { recordedAt: 'desc' },
        take: MAX_SNAPPED_ROUTE_SOURCE_POINTS,
        select: {
          id: true,
          latitude: true,
          longitude: true,
          accuracy: true,
          recordedAt: true,
        },
      })
    ).reverse();
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

    const hasGoogleDirections = Boolean(
      process.env.GOOGLE_MAPS_API_KEY?.trim(),
    );

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
      const providerErrors = [
        this.toProviderErrorMessage('primary', primaryError),
      ];
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
    const cached = reverseGeocodeCache.lookup(cacheKey);
    if (cached) {
      return cached.value;
    }

    try {
      const googleApiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
      const label = googleApiKey
        ? await this.reverseGeocodeWithGoogle(coordinate, googleApiKey)
        : await this.reverseGeocodeWithNominatim(coordinate);

      reverseGeocodeCache.setResult(cacheKey, label);
      return label;
    } catch {
      reverseGeocodeCache.set(cacheKey, null, GEOCODE_ERROR_TTL_MS);
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
    actorUserId?: string | null,
  ) {
    const shipment = await this.ensureShipmentExists(shipmentId);

    if (shipment.organizationId !== input.organizationId) {
      throw new BadRequestException(
        'organizationId does not match the shipment organization',
      );
    }

    const photoDocumentIds = [
      ...new Set(
        [input.photoDocumentId, ...(input.photoDocumentIds ?? [])].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ];
    const signatureDocumentId = input.signatureDocumentId ?? null;

    if (!photoDocumentIds.length && !signatureDocumentId) {
      throw new BadRequestException(
        'A photo or signature document is required to record proof.',
      );
    }

    // Idempotency: photos/signatures already attached to a proof of this type
    // are not linked again (driver-app retries after a partial failure).
    const existingProofs = await this.prisma.proofOfDelivery.findMany({
      where: {
        shipmentId,
        proofType: input.proofType,
        OR: [
          ...(photoDocumentIds.length
            ? [{ photoDocumentId: { in: photoDocumentIds } }]
            : []),
          ...(signatureDocumentId ? [{ signatureDocumentId }] : []),
        ],
      },
      orderBy: { capturedAt: 'asc' },
    });
    const linkedPhotoIds = new Set(
      existingProofs
        .map((proof) => proof.photoDocumentId)
        .filter((id): id is string => Boolean(id)),
    );
    const signatureAlreadyLinked = Boolean(
      signatureDocumentId &&
      existingProofs.some(
        (proof) => proof.signatureDocumentId === signatureDocumentId,
      ),
    );
    const newPhotoIds = photoDocumentIds.filter(
      (id) => !linkedPhotoIds.has(id),
    );

    if (
      !newPhotoIds.length &&
      (!signatureDocumentId || signatureAlreadyLinked)
    ) {
      const existingProof =
        existingProofs.find(
          (proof) => proof.photoDocumentId === photoDocumentIds[0],
        ) ??
        existingProofs.find(
          (proof) => proof.signatureDocumentId === signatureDocumentId,
        ) ??
        existingProofs[0];
      if (existingProof) {
        return existingProof;
      }
    }

    // Status and document ownership are enforced for anything new that is linked.
    const allowedStatuses = PROOF_ALLOWED_STATUSES[input.proofType];
    if (!allowedStatuses.includes(shipment.status)) {
      throw new ConflictException(
        input.proofType === ProofType.PICKUP
          ? `Pickup proof can only be recorded while the shipment is AT_PICKUP (current status: ${shipment.status}).`
          : `Delivery proof can only be recorded while the shipment is AT_DELIVERY or DELIVERED (current status: ${shipment.status}).`,
      );
    }

    const allDocumentIds = [
      ...new Set([
        ...photoDocumentIds,
        ...(signatureDocumentId ? [signatureDocumentId] : []),
      ]),
    ];
    const matchingDocuments = await this.prisma.document.count({
      where: {
        id: { in: allDocumentIds },
        organizationId: shipment.organizationId,
        status: { not: DocumentStatus.DELETED },
        OR: [{ shipmentId }, { entityId: shipmentId }],
      },
    });
    if (matchingDocuments !== allDocumentIds.length) {
      throw new BadRequestException(
        'One or more proof documents do not belong to this shipment.',
      );
    }

    const capturedBy = input.capturedBy ?? actorUserId ?? undefined;
    const rows: Array<{
      photoDocumentId: string | null;
      signatureDocumentId: string | null;
      remarks: string | undefined;
    }> = newPhotoIds.length
      ? newPhotoIds.map((photoDocumentId, index) => ({
          photoDocumentId,
          signatureDocumentId:
            index === 0 && signatureDocumentId && !signatureAlreadyLinked
              ? signatureDocumentId
              : null,
          remarks:
            index === 0
              ? input.remarks
              : `Additional ${input.proofType === ProofType.PICKUP ? 'pickup' : 'delivery'} photo ${index + 1} of ${newPhotoIds.length}.`,
        }))
      : [
          {
            photoDocumentId: null,
            signatureDocumentId,
            remarks: input.remarks,
          },
        ];

    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.shipment.findFirst({
        where: { id: shipmentId, status: { in: allowedStatuses } },
        select: { id: true },
      });
      if (!current) {
        throw new ConflictException(
          'The shipment status changed while recording proof. Reload and try again.',
        );
      }

      const proofs = [];
      for (const row of rows) {
        proofs.push(
          await tx.proofOfDelivery.create({
            data: {
              organizationId: shipment.organizationId,
              shipmentId,
              proofType: input.proofType,
              photoDocumentId: row.photoDocumentId,
              signatureDocumentId: row.signatureDocumentId,
              receiverName: input.receiverName,
              receiverPhone: input.receiverPhone,
              remarks: row.remarks,
              capturedBy,
            },
          }),
        );
      }

      const primaryProof = proofs[0];
      const event = {
        organizationId: shipment.organizationId,
        shipmentId,
        actorUserId: actorUserId ?? undefined,
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
          proofId: primaryProof.id,
          proofIds: proofs.map((proof) => proof.id),
          photoDocumentIds,
          signatureDocumentId,
        },
      };

      await tx.shipmentStatusEvent.create({
        data: event,
      });

      return {
        proof: primaryProof,
        orderEvent: this.toOrderEventMessage(event),
      };
    });

    this.publishOrderEventSafe(result.orderEvent);
    this.driverRealtimeService.notifyShipmentChange(shipment.currentDriverId, {
      shipmentId,
      organizationId: shipment.organizationId,
      change: 'proof_added',
    });
    return result.proof;
  }

  async planShipment(
    shipmentId: string,
    input: ShipmentStatusActionDto,
    actorUserId?: string | null,
  ) {
    return this.confirmShipment(shipmentId, input, actorUserId);
  }

  async confirmShipment(
    shipmentId: string,
    input: ShipmentStatusActionDto,
    actorUserId?: string | null,
  ) {
    const activeAssignment = await this.prisma.shipmentAssignment.findFirst({
      where: {
        shipmentId,
        organizationId: input.organizationId,
        assignmentStatus: ShipmentAssignmentStatus.ACTIVE,
      },
      select: { id: true },
    });

    return this.transitionShipmentStatus({
      shipmentId,
      organizationId: input.organizationId,
      nextStatus: activeAssignment
        ? ShipmentStatus.ASSIGNED
        : ShipmentStatus.PLANNED,
      eventType: 'shipment_confirmed',
      allowedFromStatuses: [ShipmentStatus.DRAFT],
      notes: input.notes ?? 'Shipment confirmed',
      actorUserId,
    });
  }

  async markAtPickup(
    shipmentId: string,
    input: ShipmentStatusActionDto,
    actorUserId?: string | null,
  ) {
    return this.transitionShipmentStatus({
      shipmentId,
      organizationId: input.organizationId,
      nextStatus: ShipmentStatus.AT_PICKUP,
      eventType: 'arrived_pickup',
      allowedFromStatuses: [
        ShipmentStatus.ASSIGNED,
        ShipmentStatus.EN_ROUTE_PICKUP,
      ],
      notes: input.notes ?? 'Shipment arrived at pickup',
      actorUserId,
      afterUpdate: async (tx) => {
        await this.markStops(tx, shipmentId, StopType.PICKUP, 'arrived');
      },
    });
  }

  async confirmPickup(
    shipmentId: string,
    input: ShipmentStatusActionDto,
    actorUserId?: string | null,
  ) {
    await this.assertProofExists(
      shipmentId,
      input.organizationId,
      ProofType.PICKUP,
    );

    return this.transitionShipmentStatus({
      shipmentId,
      organizationId: input.organizationId,
      nextStatus: ShipmentStatus.PICKED_UP,
      eventType: 'pickup_completed',
      allowedFromStatuses: [ShipmentStatus.AT_PICKUP],
      notes: input.notes ?? 'Shipment pickup confirmed',
      actorUserId,
      extraData: { actualPickupAt: new Date() },
      afterUpdate: async (tx) => {
        await this.markStops(tx, shipmentId, StopType.PICKUP, 'completed');
      },
    });
  }

  async markInTransit(
    shipmentId: string,
    input: ShipmentStatusActionDto,
    actorUserId?: string | null,
  ) {
    // AT_PICKUP must go through confirm-pickup (which requires pickup proof).
    return this.transitionShipmentStatus({
      shipmentId,
      organizationId: input.organizationId,
      nextStatus: ShipmentStatus.IN_TRANSIT,
      eventType: 'shipment_in_transit',
      allowedFromStatuses: [ShipmentStatus.PICKED_UP],
      notes: input.notes ?? 'Shipment marked in transit',
      actorUserId,
    });
  }

  async markAtDelivery(
    shipmentId: string,
    input: ShipmentStatusActionDto,
    actorUserId?: string | null,
  ) {
    return this.transitionShipmentStatus({
      shipmentId,
      organizationId: input.organizationId,
      nextStatus: ShipmentStatus.AT_DELIVERY,
      eventType: 'arrived_delivery',
      allowedFromStatuses: [
        ShipmentStatus.IN_TRANSIT,
        ShipmentStatus.PICKED_UP,
      ],
      notes: input.notes ?? 'Shipment arrived at delivery',
      actorUserId,
      afterUpdate: async (tx) => {
        await this.markStops(tx, shipmentId, StopType.DELIVERY, 'arrived');
      },
    });
  }

  async completeDelivery(
    shipmentId: string,
    input: ShipmentStatusActionDto,
    actorUserId?: string | null,
  ) {
    await this.assertProofExists(
      shipmentId,
      input.organizationId,
      ProofType.DELIVERY,
    );

    return this.transitionShipmentStatus({
      shipmentId,
      organizationId: input.organizationId,
      nextStatus: ShipmentStatus.DELIVERED,
      eventType: 'delivery_completed',
      allowedFromStatuses: [ShipmentStatus.AT_DELIVERY],
      notes: input.notes ?? 'Shipment delivery completed',
      actorUserId,
      extraData: { actualDeliveryAt: new Date() },
      afterUpdate: async (tx) => {
        await this.markStops(tx, shipmentId, StopType.DELIVERY, 'completed');
        await this.closeTrackingSession(tx, shipmentId);
        await this.closeActiveAssignments(
          tx,
          shipmentId,
          ShipmentAssignmentStatus.CLOSED,
        );
      },
    });
  }

  async completeShipment(
    shipmentId: string,
    input: ShipmentStatusActionDto,
    actorUserId?: string | null,
  ) {
    return this.transitionShipmentStatus({
      shipmentId,
      organizationId: input.organizationId,
      nextStatus: ShipmentStatus.COMPLETED,
      eventType: 'shipment_completed',
      allowedFromStatuses: [ShipmentStatus.DELIVERED],
      notes: input.notes ?? 'Shipment completed',
      actorUserId,
      afterUpdate: async (tx) => {
        await this.closeTrackingSession(tx, shipmentId);
        await this.closeActiveAssignments(
          tx,
          shipmentId,
          ShipmentAssignmentStatus.CLOSED,
        );
      },
    });
  }

  async failShipment(
    shipmentId: string,
    input: FailShipmentDto,
    actorUserId?: string | null,
  ) {
    return this.transitionShipmentStatus({
      shipmentId,
      organizationId: input.organizationId,
      nextStatus: ShipmentStatus.FAILED,
      eventType: 'shipment_failed',
      allowedFromStatuses: FAILABLE_STATUSES,
      notes: input.notes ?? input.reason,
      actorUserId,
      afterUpdate: async (tx) => {
        await this.closeTrackingSession(tx, shipmentId);
        await this.closeActiveAssignments(
          tx,
          shipmentId,
          ShipmentAssignmentStatus.CLOSED,
        );
      },
      metadata: {
        reason: input.reason,
      },
    });
  }

  async cancelShipment(
    shipmentId: string,
    input: ShipmentStatusActionDto,
    actorUserId?: string | null,
  ) {
    return this.transitionShipmentStatus({
      shipmentId,
      organizationId: input.organizationId,
      nextStatus: ShipmentStatus.CANCELLED,
      eventType: 'shipment_cancelled',
      allowedFromStatuses: CANCELLABLE_STATUSES,
      notes: input.notes ?? 'Shipment cancelled',
      actorUserId,
      // Release the driver and vehicle for other work.
      extraData: { currentDriverId: null, currentVehicleId: null },
      afterUpdate: async (tx) => {
        await this.closeActiveAssignments(
          tx,
          shipmentId,
          ShipmentAssignmentStatus.CANCELLED,
        );
        await this.closeTrackingSession(
          tx,
          shipmentId,
          TrackingSessionStatus.CANCELLED,
        );
      },
    });
  }

  async manuallyUpdateShipmentStatus(
    shipmentId: string,
    input: ManualShipmentStatusDto,
    actorUserId?: string | null,
  ) {
    const shipment = await this.ensureShipmentExists(shipmentId);

    if (shipment.organizationId !== input.organizationId) {
      throw new BadRequestException(
        'organizationId does not match the shipment organization',
      );
    }

    if (!Object.values(ShipmentStatus).includes(input.status)) {
      throw new BadRequestException('status is invalid');
    }

    if (shipment.status === input.status) {
      return this.getShipmentById(shipmentId);
    }

    const target = input.status;
    if (!MANUAL_STATUS_TRANSITIONS[shipment.status].includes(target)) {
      const allowed = MANUAL_STATUS_TRANSITIONS[shipment.status];
      throw new ConflictException(
        allowed.length
          ? `Shipment cannot move from ${shipment.status} to ${target}. Allowed: ${allowed.join(', ')}.`
          : `Shipment is ${shipment.status} and its status can no longer be changed.`,
      );
    }

    if (
      DRIVER_REQUIRED_STATUSES.includes(target) &&
      !shipment.currentDriverId
    ) {
      throw new BadRequestException(
        `Assign a driver before moving the shipment to ${target}.`,
      );
    }

    if (target === ShipmentStatus.PICKED_UP) {
      await this.assertProofExists(
        shipmentId,
        input.organizationId,
        ProofType.PICKUP,
      );
    }

    if (target === ShipmentStatus.DELIVERED) {
      await this.assertProofExists(
        shipmentId,
        input.organizationId,
        ProofType.DELIVERY,
      );
    }

    const now = new Date();

    await this.transitionShipmentStatus({
      shipmentId,
      organizationId: input.organizationId,
      nextStatus: target,
      eventType: 'shipment_status_manual_update',
      // Guard on the exact status validated above.
      allowedFromStatuses: [shipment.status],
      notes: input.notes || `Status manually changed to ${target}`,
      actorUserId,
      source: EventSource.ADMIN,
      metadata: { manual: true },
      extraData:
        target === ShipmentStatus.CANCELLED
          ? { currentDriverId: null, currentVehicleId: null }
          : undefined,
      afterUpdate: async (tx) => {
        if (
          target === ShipmentStatus.PICKED_UP ||
          target === ShipmentStatus.IN_TRANSIT ||
          target === ShipmentStatus.AT_DELIVERY
        ) {
          await tx.shipment.updateMany({
            where: { id: shipmentId, actualPickupAt: null },
            data: { actualPickupAt: now },
          });
        }

        if (target === ShipmentStatus.DELIVERED) {
          await tx.shipment.updateMany({
            where: { id: shipmentId, actualDeliveryAt: null },
            data: { actualDeliveryAt: now },
          });
        }

        if (target === ShipmentStatus.AT_PICKUP) {
          await this.markStops(tx, shipmentId, StopType.PICKUP, 'arrived');
        }
        if (target === ShipmentStatus.PICKED_UP) {
          await this.markStops(tx, shipmentId, StopType.PICKUP, 'completed');
        }
        if (target === ShipmentStatus.AT_DELIVERY) {
          await this.markStops(tx, shipmentId, StopType.DELIVERY, 'arrived');
        }
        if (target === ShipmentStatus.DELIVERED) {
          await this.markStops(tx, shipmentId, StopType.DELIVERY, 'completed');
        }

        if (target === ShipmentStatus.CANCELLED) {
          await this.closeActiveAssignments(
            tx,
            shipmentId,
            ShipmentAssignmentStatus.CANCELLED,
          );
          await this.closeTrackingSession(
            tx,
            shipmentId,
            TrackingSessionStatus.CANCELLED,
          );
        } else if (TERMINAL_SHIPMENT_STATUSES.includes(target)) {
          await this.closeTrackingSession(tx, shipmentId);
          await this.closeActiveAssignments(
            tx,
            shipmentId,
            ShipmentAssignmentStatus.CLOSED,
          );
        }
      },
    });

    return this.getShipmentById(shipmentId);
  }

  async deleteShipment(
    shipmentId: string,
    organizationId: string,
    reason?: string | null,
    deletedByUserId?: string | null,
  ) {
    const shipment = await this.ensureShipmentExists(shipmentId);

    if (shipment.organizationId !== organizationId) {
      throw new BadRequestException(
        'organizationId does not match the shipment organization',
      );
    }

    const deletableStatuses: ShipmentStatus[] = [
      ShipmentStatus.DRAFT,
      ShipmentStatus.PLANNED,
      ShipmentStatus.CANCELLED,
    ];

    if (!deletableStatuses.includes(shipment.status)) {
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
      await tx.deletionAudit.create({
        data: {
          organizationId,
          entityType: 'SHIPMENT',
          entityId: shipment.id,
          entityLabel: shipment.shipmentCode,
          reason: reason?.trim() || 'Shipment deleted',
          deletedByUserId: deletedByUserId ?? undefined,
        },
      });

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

      const deleted = await tx.shipment.deleteMany({
        where: { id: shipmentId, status: { in: deletableStatuses } },
      });

      if (deleted.count === 0) {
        throw new ConflictException(
          'The shipment status changed and it can no longer be deleted.',
        );
      }
    });

    return {
      id: shipmentId,
      deleted: true,
    };
  }

  private async sendShipmentUpdateEmail(
    shipment: {
      organizationId: string;
      shipmentCode: string;
      companyClient?: {
        contactEmail?: string | null;
        contactPerson?: string | null;
        name?: string | null;
      } | null;
    },
    title: string,
    message: string,
  ) {
    try {
      const verifiedMembers = await this.prisma.organizationUser.findMany({
        where: {
          organizationId: shipment.organizationId,
          status: MembershipStatus.ACTIVE,
          user: {
            emailVerifiedAt: { not: null },
            status: UserStatus.ACTIVE,
          },
        },
        select: {
          user: { select: { email: true, fullName: true } },
        },
      });

      await Promise.allSettled(
        verifiedMembers.map(({ user }) =>
          this.mailService.sendOperationalUpdateEmail({
            to: user.email,
            recipientName: user.fullName,
            title,
            message,
            reference: shipment.shipmentCode,
          }),
        ),
      );
    } catch {
      // A notification failure must not roll back a successfully saved shipment.
    }
  }

  // Pickup can come from another client (client-to-client shipments), so the
  // source/destination may be any client location, but never one that belongs
  // to a different organization.
  private async assertShipmentLocationsBelongToOrganization(
    input: CreateShipmentDto,
  ) {
    const locationIds = [
      input.sourceLocationId,
      input.destinationLocationId,
    ].filter((id): id is string => Boolean(id));
    if (!locationIds.length) return;

    const matches = await this.prisma.companyClientLocation.count({
      where: {
        id: { in: locationIds },
        organizationId: input.organizationId,
      },
    });

    if (matches !== new Set(locationIds).size) {
      throw new BadRequestException(
        'Pickup or delivery location does not belong to this organization',
      );
    }
  }

  private async assertCompanyClientBelongsToOrganization(
    organizationId: string,
    companyClientId?: string | null,
  ) {
    if (!companyClientId) {
      return;
    }

    const client = await this.prisma.companyClient.findFirst({
      where: { id: companyClientId, organizationId },
      select: { id: true },
    });

    if (!client) {
      throw new BadRequestException(
        'The selected client does not belong to this organization',
      );
    }
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
      input.shipmentType !== ShipmentType.INBOUND &&
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

  private validatePlannedDates(
    plannedPickupAt?: string | null,
    plannedDeliveryAt?: string | null,
  ) {
    if (!plannedPickupAt || !plannedDeliveryAt) {
      return;
    }

    const pickup = new Date(plannedPickupAt).getTime();
    const delivery = new Date(plannedDeliveryAt).getTime();

    if (
      Number.isFinite(pickup) &&
      Number.isFinite(delivery) &&
      delivery < pickup
    ) {
      throw new BadRequestException(
        'plannedDeliveryAt must be the same as or later than plannedPickupAt',
      );
    }
  }

  private assertUniqueStopSequences(stops?: CreateShipmentStopDto[]) {
    if (!stops?.length) {
      return;
    }

    const sequences = stops.map((stop) => stop.stopSequence);
    if (new Set(sequences).size !== sequences.length) {
      throw new BadRequestException(
        'Each stop must have a unique stopSequence',
      );
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
      where: { organizationId, shipmentCode: { startsWith: `${prefix}-SHP-` } },
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

  private async isInvoiceNumberTaken(
    organizationId: string,
    invoiceNumber?: string | null,
    excludeShipmentId?: string,
  ) {
    if (!invoiceNumber) {
      return false;
    }

    const match = await this.prisma.shipment.findFirst({
      where: {
        organizationId,
        invoiceNumber,
        ...(excludeShipmentId ? { id: { not: excludeShipmentId } } : {}),
      },
      select: { id: true },
    });

    return Boolean(match);
  }

  /** Converts unique violations into a readable 409; rethrows anything else. */
  private async rethrowUniqueViolation(
    error: unknown,
    organizationId: string,
    invoiceNumber?: string | null,
    excludeShipmentId?: string,
  ): Promise<never> {
    if (!isUniqueConstraintViolation(error)) {
      throw error;
    }

    if (
      await this.isInvoiceNumberTaken(
        organizationId,
        invoiceNumber,
        excludeShipmentId,
      )
    ) {
      throw new ConflictException(
        `Invoice number ${invoiceNumber} is already used by another shipment in this organization`,
      );
    }

    throw new ConflictException(
      'A shipment with the same code already exists. Please retry or use a different code.',
    );
  }

  private async transitionShipmentStatus(options: TransitionOptions) {
    const {
      shipmentId,
      organizationId,
      nextStatus,
      eventType,
      allowedFromStatuses,
      notes,
      actorUserId,
      afterUpdate,
      metadata,
      extraData,
    } = options;
    const shipment = await this.ensureShipmentExists(shipmentId);

    if (shipment.organizationId !== organizationId) {
      throw new BadRequestException(
        'organizationId does not match the shipment organization',
      );
    }

    if (!allowedFromStatuses.includes(shipment.status)) {
      throw new ConflictException(
        `Shipment cannot move from ${shipment.status} to ${nextStatus}`,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Guarded transition: only succeeds if the status is still one of the
      // allowed source statuses at write time.
      const guard = await tx.shipment.updateMany({
        where: {
          id: shipmentId,
          organizationId,
          status: { in: allowedFromStatuses },
        },
        data: {
          ...(extraData ?? {}),
          status: nextStatus,
        },
      });

      if (guard.count === 0) {
        throw new ConflictException(
          `Shipment status changed concurrently; it can no longer move to ${nextStatus}. Reload and try again.`,
        );
      }

      if (afterUpdate) {
        await afterUpdate(tx);
      }

      const event = {
        organizationId,
        shipmentId,
        actorUserId: actorUserId ?? undefined,
        eventType,
        fromStatus: shipment.status,
        toStatus: nextStatus,
        source: options.source ?? EventSource.API,
        notes: notes ?? null,
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
        shipmentDetails,
        orderEvent: this.toOrderEventMessage(event),
      };
    });

    this.publishOrderEventSafe(result.orderEvent);
    this.driverRealtimeService.notifyShipmentChange(shipment.currentDriverId, {
      shipmentId,
      organizationId,
      change: 'status_changed',
    });

    // Coordinates are resolved after the transaction from stored data only, so
    // an external geocoder can never stall or roll back a status change.
    return result.shipmentDetails
      ? this.toStoredCoordinateResponse(result.shipmentDetails)
      : null;
  }

  private async assertProofExists(
    shipmentId: string,
    organizationId: string,
    proofType: ProofType,
  ) {
    const proofCount = await this.prisma.proofOfDelivery.count({
      where: {
        shipmentId,
        organizationId,
        proofType,
      },
    });

    if (proofCount === 0) {
      throw new BadRequestException(
        proofType === ProofType.PICKUP
          ? 'Pickup proof is required before confirming pickup'
          : 'At least one delivery proof is required before completing delivery',
      );
    }
  }

  private async markStops(
    tx: Prisma.TransactionClient,
    shipmentId: string,
    stopType: StopType,
    stage: 'arrived' | 'completed',
  ) {
    const now = new Date();

    if (stage === 'arrived') {
      await tx.shipmentStop.updateMany({
        where: { shipmentId, stopType },
        data: { status: StopStatus.ARRIVED },
      });
      await tx.shipmentStop.updateMany({
        where: { shipmentId, stopType, actualArrivalAt: null },
        data: { actualArrivalAt: now },
      });
      return;
    }

    await tx.shipmentStop.updateMany({
      where: { shipmentId, stopType },
      data: { status: StopStatus.COMPLETED, actualDepartureAt: now },
    });
    await tx.shipmentStop.updateMany({
      where: { shipmentId, stopType, actualArrivalAt: null },
      data: { actualArrivalAt: now },
    });
  }

  private async closeTrackingSession(
    tx: Prisma.TransactionClient,
    shipmentId: string,
    status: TrackingSessionStatus = TrackingSessionStatus.COMPLETED,
  ) {
    await tx.trackingSession.updateMany({
      where: { shipmentId, status: TrackingSessionStatus.ACTIVE },
      data: {
        status,
        endedAt: new Date(),
      },
    });

    await tx.shipment.updateMany({
      where: { id: shipmentId, currentTrackingSessionId: { not: null } },
      data: {
        currentTrackingSessionId: null,
      },
    });
  }

  private async closeActiveAssignments(
    tx: Prisma.TransactionClient,
    shipmentId: string,
    status: ShipmentAssignmentStatus,
  ) {
    await tx.shipmentAssignment.updateMany({
      where: {
        shipmentId,
        assignmentStatus: ShipmentAssignmentStatus.ACTIVE,
      },
      data: {
        assignmentStatus: status,
        unassignedAt: new Date(),
      },
    });
  }

  private async findActiveSessionForDriver(
    trackingSessionId: string | null,
    shipmentId: string,
    driverId: string,
  ) {
    if (!trackingSessionId) {
      return null;
    }

    const session = await this.prisma.trackingSession.findUnique({
      where: { id: trackingSessionId },
    });

    return session &&
      session.status === TrackingSessionStatus.ACTIVE &&
      session.shipmentId === shipmentId &&
      session.driverId === driverId
      ? session
      : null;
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

  // ---------------------------------------------------------------------------
  // Update helpers (stops / items / route coordinates / snapshots)
  // ---------------------------------------------------------------------------

  private toItemCreateData(
    organizationId: string,
    item: CreateShipmentItemDto,
  ) {
    return {
      organizationId,
      description: item.description,
      quantity: new Prisma.Decimal(item.quantity),
      unit: item.unit,
      weight:
        item.weight !== undefined ? new Prisma.Decimal(item.weight) : undefined,
      volume:
        item.volume !== undefined ? new Prisma.Decimal(item.volume) : undefined,
      declaredValue:
        item.declaredValue !== undefined
          ? new Prisma.Decimal(item.declaredValue)
          : undefined,
    };
  }

  private toStopCreateData(
    organizationId: string,
    stop: CreateShipmentStopDto,
  ) {
    return {
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
    };
  }

  private toStopDto(stop: ExistingStop): CreateShipmentStopDto {
    return {
      stopSequence: stop.stopSequence,
      stopType: stop.stopType,
      locationName: stop.locationName,
      addressLine1: stop.addressLine1 ?? undefined,
      addressLine2: stop.addressLine2 ?? undefined,
      city: stop.city ?? undefined,
      state: stop.state ?? undefined,
      postalCode: stop.postalCode ?? undefined,
      country: stop.country ?? undefined,
      plannedArrivalAt: stop.plannedArrivalAt?.toISOString(),
      plannedDepartureAt: stop.plannedDepartureAt?.toISOString(),
    };
  }

  private stopAddressKey(stop: {
    stopType: string;
    locationName?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    country?: string | null;
  }) {
    const normalize = (value: unknown) => textOf(value).trim().toLowerCase();

    return [
      stop.stopType,
      normalize(stop.locationName),
      normalize(stop.addressLine1),
      normalize(stop.addressLine2),
      normalize(stop.city),
      normalize(stop.state),
      normalize(stop.postalCode),
      normalize(stop.country || 'India'),
    ].join('|');
  }

  private planStopChanges(
    existingStops: ExistingStop[],
    inputStops: CreateShipmentStopDto[],
  ): StopChangePlan {
    const existingBySequence = new Map(
      existingStops.map((stop) => [stop.stopSequence, stop]),
    );
    const locationChanged =
      existingStops.length !== inputStops.length ||
      inputStops.some((stop) => {
        const current = existingBySequence.get(stop.stopSequence);
        return (
          !current || this.stopAddressKey(current) !== this.stopAddressKey(stop)
        );
      });

    const sideKey = (
      stops: Array<Parameters<ShipmentsService['stopAddressKey']>[0]>,
      side: RouteSide,
    ) => {
      const stop = stops.find((candidate) => candidate.stopType === side);
      return stop ? this.stopAddressKey(stop) : '';
    };

    return {
      locationChanged,
      pickupChanged:
        sideKey(existingStops, 'PICKUP') !== sideKey(inputStops, 'PICKUP'),
      deliveryChanged:
        sideKey(existingStops, 'DELIVERY') !== sideKey(inputStops, 'DELIVERY'),
    };
  }

  /**
   * Applies stop edits in place (matched by stopSequence) so arrival/departure
   * progress survives edits that do not change the stop's address. Stops whose
   * address changes are reset to PENDING; missing stops are removed.
   */
  private async applyStopChanges(
    tx: Prisma.TransactionClient,
    shipmentId: string,
    organizationId: string,
    existingStops: ExistingStop[],
    inputStops: CreateShipmentStopDto[],
  ) {
    const existingBySequence = new Map(
      existingStops.map((stop) => [stop.stopSequence, stop]),
    );
    const inputSequences = new Set(inputStops.map((stop) => stop.stopSequence));
    const removedStopIds = existingStops
      .filter((stop) => !inputSequences.has(stop.stopSequence))
      .map((stop) => stop.id);

    if (removedStopIds.length) {
      await tx.shipmentStop.deleteMany({
        where: { id: { in: removedStopIds }, shipmentId },
      });
    }

    for (const stop of inputStops) {
      const current = existingBySequence.get(stop.stopSequence);

      if (!current) {
        await tx.shipmentStop.create({
          data: {
            ...this.toStopCreateData(organizationId, stop),
            shipmentId,
          },
        });
        continue;
      }

      const addressChanged =
        this.stopAddressKey(current) !== this.stopAddressKey(stop);

      await tx.shipmentStop.update({
        where: { id: current.id },
        data: {
          stopType: stop.stopType,
          locationName: stop.locationName,
          addressLine1: stop.addressLine1 ?? null,
          addressLine2: stop.addressLine2 ?? null,
          city: stop.city ?? null,
          state: stop.state ?? null,
          postalCode: stop.postalCode ?? null,
          country: stop.country ?? 'India',
          plannedArrivalAt: stop.plannedArrivalAt
            ? new Date(stop.plannedArrivalAt)
            : null,
          plannedDepartureAt: stop.plannedDepartureAt
            ? new Date(stop.plannedDepartureAt)
            : null,
          ...(addressChanged
            ? {
                status: StopStatus.PENDING,
                actualArrivalAt: null,
                actualDepartureAt: null,
              }
            : {}),
        },
      });
    }
  }

  private planItemChanges(
    existingItems: ExistingItem[],
    inputItems: CreateShipmentItemDto[],
  ): ItemChangePlan {
    if (existingItems.length !== inputItems.length) {
      return 'replace';
    }

    const toNumber = (value: unknown) =>
      value === null || value === undefined ? null : Number(value);
    const sameNumber = (left: unknown, right: unknown) =>
      toNumber(left) === toNumber(right);

    let detailsChanged = false;
    for (let index = 0; index < inputItems.length; index += 1) {
      const current = existingItems[index];
      const next = inputItems[index];

      if (
        current.description.trim() !== next.description.trim() ||
        current.unit.trim() !== next.unit.trim() ||
        !sameNumber(current.quantity, next.quantity)
      ) {
        return 'replace';
      }

      if (
        !sameNumber(current.weight, next.weight) ||
        !sameNumber(current.volume, next.volume) ||
        !sameNumber(current.declaredValue, next.declaredValue)
      ) {
        detailsChanged = true;
      }
    }

    return detailsChanged ? 'details' : 'unchanged';
  }

  private async applyItemChanges(
    tx: Prisma.TransactionClient,
    shipmentId: string,
    organizationId: string,
    existingItems: ExistingItem[],
    inputItems: CreateShipmentItemDto[],
    plan: ItemChangePlan,
  ) {
    if (plan === 'details') {
      for (let index = 0; index < inputItems.length; index += 1) {
        const next = inputItems[index];
        await tx.shipmentItem.update({
          where: { id: existingItems[index].id },
          data: {
            weight:
              next.weight !== undefined
                ? new Prisma.Decimal(next.weight)
                : null,
            volume:
              next.volume !== undefined
                ? new Prisma.Decimal(next.volume)
                : null,
            declaredValue:
              next.declaredValue !== undefined
                ? new Prisma.Decimal(next.declaredValue)
                : null,
          },
        });
      }
      return;
    }

    if (plan === 'replace') {
      // `items: []` is an explicit "remove all items" (only reachable before
      // dispatch; locked shipments are rejected earlier).
      await tx.shipmentItem.deleteMany({ where: { shipmentId } });
      if (inputItems.length) {
        await tx.shipmentItem.createMany({
          data: inputItems.map((item) => ({
            ...this.toItemCreateData(organizationId, item),
            shipmentId,
          })),
        });
      }
    }
  }

  private preserveRouteFormKeys(
    existingFormData: Record<string, unknown>,
    nextFormData: Record<string, unknown>,
  ) {
    const merged: Record<string, unknown> = { ...nextFormData };

    for (const key of ROUTE_FORM_KEYS) {
      if (Object.prototype.hasOwnProperty.call(existingFormData, key)) {
        merged[key] = existingFormData[key];
      } else {
        delete merged[key];
      }
    }

    return merged;
  }

  private routeFormAddressChanged(
    existingFormData: Record<string, unknown>,
    nextFormData: Record<string, unknown> | undefined,
    side: RouteSide,
  ) {
    if (!nextFormData) {
      return false;
    }

    const normalize = (value: unknown) => textOf(value).trim().toLowerCase();

    return ROUTE_ADDRESS_FORM_KEYS[side].some(
      (key) =>
        normalize(existingFormData[key]) !== normalize(nextFormData[key]),
    );
  }

  /**
   * For each route side: when the address is unchanged keep the submitted (or
   * previously stored) pin and never block on the geocoder; when it changed,
   * trust a newly pinned coordinate, else geocode (and fail if unresolvable).
   * Mutates `input.adminFormData`.
   */
  private async resolveRouteCoordinatesForUpdate(
    input: CreateShipmentDto,
    existingFormData: Record<string, unknown>,
    changed: Record<RouteSide, boolean>,
  ) {
    const formData = this.asRecord(input.adminFormData);
    const hasRouteInformation = Boolean(
      input.stops?.length || formData.originAddress || formData.deliveryAddress,
    );
    if (!hasRouteInformation) {
      return;
    }

    const nextFormData: Record<string, unknown> = { ...formData };

    for (const side of ['PICKUP', 'DELIVERY'] as RouteSide[]) {
      const keys = ROUTE_COORDINATE_FORM_KEYS[side];
      const existingCoordinate = this.firstValidCoordinate([
        existingFormData[keys.latitude],
        existingFormData[keys.longitude],
      ]);
      const submittedCoordinate = this.firstValidCoordinate([
        formData[keys.latitude],
        formData[keys.longitude],
      ]);

      let coordinate: Coordinate | null;
      let verifiedAt: unknown;

      if (!changed[side]) {
        coordinate = submittedCoordinate ?? existingCoordinate;
        verifiedAt =
          formData[keys.verifiedAt] || existingFormData[keys.verifiedAt];
        if (!coordinate) {
          try {
            coordinate = await this.resolveRequiredStopCoordinate(input, side);
            verifiedAt = new Date().toISOString();
          } catch {
            // Geocoder down / incomplete legacy address: do not block the edit.
            coordinate = null;
          }
        }
      } else if (
        submittedCoordinate &&
        !this.isSameCoordinate(submittedCoordinate, existingCoordinate)
      ) {
        coordinate = submittedCoordinate;
        verifiedAt = formData[keys.verifiedAt] || new Date().toISOString();
      } else {
        coordinate = await this.resolveRequiredStopCoordinate(input, side);
        verifiedAt = new Date().toISOString();
      }

      if (coordinate) {
        nextFormData[keys.latitude] = String(coordinate.latitude);
        nextFormData[keys.longitude] = String(coordinate.longitude);
        if (verifiedAt) {
          nextFormData[keys.verifiedAt] = verifiedAt;
        }
      }
    }

    input.adminFormData = nextFormData;
  }

  private isSameCoordinate(left: Coordinate | null, right: Coordinate | null) {
    if (!left || !right) {
      return false;
    }

    return (
      Math.abs(left.latitude - right.latitude) < 1e-6 &&
      Math.abs(left.longitude - right.longitude) < 1e-6
    );
  }

  /**
   * Freezes the pickup/delivery address at creation (or route edit) so later
   * edits to a client location do not rewrite historical shipments.
   */
  private async buildAddressSnapshots(input: CreateShipmentDto): Promise<{
    source: Prisma.InputJsonValue | null;
    destination: Prisma.InputJsonValue | null;
  }> {
    const locationIds = [
      input.sourceLocationId,
      input.destinationLocationId,
    ].filter((id): id is string => Boolean(id));
    const locations = locationIds.length
      ? await this.prisma.companyClientLocation.findMany({
          where: {
            id: { in: locationIds },
            organizationId: input.organizationId,
          },
        })
      : [];
    const formData = this.asRecord(input.adminFormData);
    const capturedAt = new Date().toISOString();
    const text = (value: unknown) => {
      const normalized = textOf(value).trim();
      return normalized || null;
    };

    const build = (side: RouteSide): Prisma.InputJsonValue | null => {
      const isPickup = side === 'PICKUP';
      const locationId = isPickup
        ? input.sourceLocationId
        : input.destinationLocationId;
      const location = locations.find(
        (candidate) => candidate.id === locationId,
      );
      const stop = input.stops?.find(
        (candidate) => candidate.stopType === side,
      );
      const keys = ROUTE_COORDINATE_FORM_KEYS[side];
      const coordinate = this.firstValidCoordinate([
        formData[keys.latitude],
        formData[keys.longitude],
      ]);

      let base: Record<string, string | null> | null = null;
      if (location) {
        base = {
          source: 'company_client_location',
          locationId: location.id,
          companyClientId: location.companyClientId,
          name: location.name,
          addressLine1: location.addressLine1,
          addressLine2: location.addressLine2,
          city: location.city,
          state: location.state,
          postalCode: location.postalCode,
          country: location.country,
          gstin: location.gstin,
          contactName: location.contactName,
          contactPhone: location.contactPhone,
        };
      } else if (stop) {
        base = {
          source: 'shipment_stop',
          name: text(stop.locationName),
          addressLine1: text(stop.addressLine1),
          addressLine2: text(stop.addressLine2),
          city: text(stop.city),
          state: text(stop.state),
          postalCode: text(stop.postalCode),
          country: text(stop.country) ?? 'India',
        };
      } else if (formData[isPickup ? 'originAddress' : 'deliveryAddress']) {
        base = {
          source: 'admin_form',
          name: text(formData[isPickup ? 'originName' : 'destinationName']),
          addressLine1: text(
            formData[isPickup ? 'originAddress' : 'deliveryAddress'],
          ),
          addressLine2: null,
          city: text(formData[isPickup ? 'originCity' : 'destinationCity']),
          state: text(formData[isPickup ? 'originState' : 'destinationState']),
          postalCode: text(
            formData[isPickup ? 'originPincode' : 'destinationPincode'],
          ),
          country:
            text(formData[isPickup ? 'originCountry' : 'destinationCountry']) ??
            'India',
        };
      }

      if (!base) {
        return null;
      }

      return {
        ...base,
        latitude: coordinate?.latitude ?? null,
        longitude: coordinate?.longitude ?? null,
        capturedAt,
      };
    };

    return {
      source: build('PICKUP'),
      destination: build('DELIVERY'),
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  }

  private clampInteger(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
  ) {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }

    const parsed = Math.trunc(Number(value));
    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return Math.min(Math.max(parsed, min), max);
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

  /** Detail responses: stored coordinates first, geocoding as a fallback. */
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
    const [resolvedPickupCoordinates, resolvedDestinationCoordinates] =
      await Promise.all([
        this.resolveShipmentCoordinate(shipment, 'pickup'),
        this.resolveShipmentCoordinate(shipment, 'destination'),
      ]);

    return {
      ...mappedShipment,
      resolvedPickupCoordinates,
      resolvedDestinationCoordinates,
    };
  }

  /** List/status responses: stored coordinates only, never calls a geocoder. */
  private toStoredCoordinateResponse<
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
    return {
      ...this.mapShipmentCompanyClient(shipment),
      resolvedPickupCoordinates: this.getShipmentCoordinateContext(
        shipment,
        'pickup',
      ).directCoordinate,
      resolvedDestinationCoordinates: this.getShipmentCoordinateContext(
        shipment,
        'destination',
      ).directCoordinate,
    };
  }

  private getShipmentCoordinateContext(
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
    const formData = this.asRecord(shipment.adminFormData);
    const stopType = kind === 'pickup' ? 'PICKUP' : 'DELIVERY';
    const stop =
      shipment.stops?.find((candidate) => candidate.stopType === stopType) ||
      null;
    const location =
      kind === 'pickup'
        ? shipment.sourceLocation
        : shipment.destinationLocation;
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
        formData[
          kind === 'pickup' ? 'originLongitude' : 'destinationLongitude'
        ],
      ],
      [
        formData[kind === 'pickup' ? 'pickupLatitude' : 'receiverLatitude'],
        formData[kind === 'pickup' ? 'pickupLongitude' : 'receiverLongitude'],
      ],
      [snapshot?.latitude, snapshot?.longitude],
      [stop?.latitude, stop?.longitude],
      [location?.latitude, location?.longitude],
    );

    return { formData, stop, location, snapshot, directCoordinate };
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
    const { formData, stop, location, snapshot, directCoordinate } =
      this.getShipmentCoordinateContext(shipment, kind);

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
        this.calculateDistanceMetres(previous, point) <
          MIN_ROUTE_POINT_DISTANCE_METRES
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
      if (
        this.calculateDistanceMetres(previous, point) >=
        MIN_SNAP_POINT_DISTANCE_METRES
      ) {
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
      const sourceIndex = Math.round(
        (index * lastIndex) / (MAX_SNAP_POINTS - 1),
      );
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
      throw new Error(
        payload.message || payload.code || 'OSRM Match returned no geometry',
      );
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
      throw new Error(
        payload.message || payload.code || 'OSRM Route returned no geometry',
      );
    }

    return route;
  }

  private async fetchGoogleRoadsRoute(points: TrackingRoutePoint[]) {
    const googleApiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
    if (!googleApiKey) {
      throw new Error('GOOGLE_MAPS_API_KEY is not configured');
    }

    const snapPoints = this.simplifyRoutePointsForSnapping(points);
    const chunks = this.chunkRoutePoints(
      snapPoints,
      GOOGLE_ROADS_POINT_BATCH_SIZE,
    );
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
        payload.error.message ||
          payload.error.status ||
          'Google Roads returned an error',
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
        payload.error_message ||
          payload.status ||
          'Google Directions returned no geometry',
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
      .map(
        (point) => `${point.longitude.toFixed(6)},${point.latitude.toFixed(6)}`,
      )
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

  private setSnappedRouteCache(
    cacheKey: string,
    response: SnappedRouteResponse,
  ) {
    snappedRouteCache.set(cacheKey, {
      expiresAt: Date.now() + ROUTE_CACHE_TTL_MS,
      response,
    });

    while (snappedRouteCache.size > MAX_ROUTE_CACHE_ENTRIES) {
      const [oldestKey] = snappedRouteCache.keys();
      if (oldestKey === undefined) {
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

    return [
      ...new Set(
        rawCandidates
          .map((parts) =>
            parts
              .map((part) => textOf(part).trim())
              .filter(Boolean)
              .join(', '),
          )
          .filter(Boolean)
          .map((candidate) =>
            /\bindia\b/i.test(candidate) ? candidate : `${candidate}, India`,
          ),
      ),
    ];
  }

  async validateShipmentLocation(input: ValidateShipmentLocationDto) {
    const address = this.buildRequiredLocationAddress({
      locationName: input.locationName,
      addressLine1: input.addressLine1,
      city: input.city,
      state: input.state,
      postalCode: input.postalCode,
    });
    const coordinate = await this.geocodeAddress(address);

    if (!coordinate) {
      throw new BadRequestException(
        'We could not find this location. Enter the building, street/landmark, city, and correct 6-digit PIN, then try again.',
      );
    }

    return {
      address,
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      verifiedAt: new Date().toISOString(),
    };
  }

  private async normalizeRequiredRouteCoordinates(input: CreateShipmentDto) {
    const adminFormData = this.asRecord(input.adminFormData);

    // Code-only inbound drafts may be created before route information arrives.
    // They still cannot be assigned because assignDriver checks both resolved pins.
    const hasRouteInformation = Boolean(
      input.stops?.length ||
      adminFormData.originAddress ||
      adminFormData.deliveryAddress,
    );
    if (!hasRouteInformation) {
      return;
    }

    const nextFormData: Record<string, unknown> = { ...adminFormData };

    for (const side of ['PICKUP', 'DELIVERY'] as RouteSide[]) {
      const keys = ROUTE_COORDINATE_FORM_KEYS[side];
      const pinnedCoordinate = this.firstValidCoordinate([
        adminFormData[keys.latitude],
        adminFormData[keys.longitude],
      ]);

      // Keep a pin the user already verified (validate-location / map pin);
      // the address itself must still be complete.
      if (pinnedCoordinate && adminFormData[keys.verifiedAt]) {
        this.buildRequiredStopAddress(input, side);
        nextFormData[keys.latitude] = String(pinnedCoordinate.latitude);
        nextFormData[keys.longitude] = String(pinnedCoordinate.longitude);
        continue;
      }

      const coordinate = await this.resolveRequiredStopCoordinate(input, side);
      nextFormData[keys.latitude] = String(coordinate.latitude);
      nextFormData[keys.longitude] = String(coordinate.longitude);
      nextFormData[keys.verifiedAt] = new Date().toISOString();
    }

    input.adminFormData = nextFormData;
  }

  private buildRequiredStopAddress(
    input: CreateShipmentDto,
    stopType: RouteSide,
  ) {
    const stop = input.stops?.find(
      (candidate) => candidate.stopType === stopType,
    );
    const isPickup = stopType === 'PICKUP';
    const adminFormData = this.asRecord(input.adminFormData);

    return this.buildRequiredLocationAddress({
      locationName:
        stop?.locationName ||
        adminFormData[isPickup ? 'originName' : 'destinationName'],
      addressLine1:
        stop?.addressLine1 ||
        adminFormData[isPickup ? 'originAddress' : 'deliveryAddress'],
      city:
        stop?.city ||
        adminFormData[isPickup ? 'originCity' : 'destinationCity'],
      state:
        stop?.state ||
        adminFormData[isPickup ? 'originState' : 'destinationState'],
      postalCode:
        stop?.postalCode ||
        adminFormData[isPickup ? 'originPincode' : 'destinationPincode'],
    });
  }

  private async resolveRequiredStopCoordinate(
    input: CreateShipmentDto,
    stopType: RouteSide,
  ) {
    const isPickup = stopType === 'PICKUP';
    const address = this.buildRequiredStopAddress(input, stopType);
    const coordinate = await this.geocodeAddress(address);

    if (!coordinate) {
      throw new BadRequestException(
        `A valid ${isPickup ? 'pickup' : 'delivery'} location is required before this shipment can be created or assigned. Verify the street address and 6-digit PIN.`,
      );
    }

    return coordinate;
  }

  private buildRequiredLocationAddress(input: {
    locationName?: unknown;
    addressLine1?: unknown;
    city?: unknown;
    state?: unknown;
    postalCode?: unknown;
  }) {
    const addressLine1 = textOf(input.addressLine1).trim();
    const city = textOf(input.city).trim();
    const postalCode = textOf(input.postalCode).trim();

    if (!addressLine1 || !city || !/^\d{6}$/.test(postalCode)) {
      throw new BadRequestException(
        'Every pickup and delivery stop needs a street address, city, and valid 6-digit PIN before it can be routed.',
      );
    }

    return [
      input.locationName,
      addressLine1,
      city,
      input.state,
      postalCode,
      'India',
    ]
      .map((value) => textOf(value).trim())
      .filter(Boolean)
      .join(', ');
  }

  private async geocodeAddress(address: string): Promise<Coordinate | null> {
    const normalizedAddress = address.trim();
    if (!normalizedAddress) {
      return null;
    }

    const cached = geocodeCache.lookup(normalizedAddress);
    if (cached) {
      return cached.value;
    }

    try {
      const googleApiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
      const coordinate = googleApiKey
        ? await this.geocodeWithGoogle(normalizedAddress, googleApiKey)
        : await this.geocodeWithNominatim(normalizedAddress);

      // Misses are cached for minutes, hits for a day (bounded LRU).
      geocodeCache.setResult(normalizedAddress, coordinate);
      return coordinate;
    } catch {
      geocodeCache.set(normalizedAddress, null, GEOCODE_ERROR_TTL_MS);
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
      signal: AbortSignal.timeout(GEOCODE_FETCH_TIMEOUT_MS),
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

  private async geocodeWithNominatim(
    address: string,
  ): Promise<Coordinate | null> {
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
      signal: AbortSignal.timeout(GEOCODE_FETCH_TIMEOUT_MS),
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
    url.searchParams.set(
      'latlng',
      `${coordinate.latitude},${coordinate.longitude}`,
    );
    url.searchParams.set('key', apiKey);
    url.searchParams.set('region', 'in');

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(GEOCODE_FETCH_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(GEOCODE_FETCH_TIMEOUT_MS),
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
  >(companyClient: T) {
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

  /**
   * Fire-and-forget: the DB commit is the source of truth, so a slow or
   * unavailable broker must never delay (or fail) the HTTP response.
   */
  private publishOrderEventSafe(event: OrderEventMessage) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`timed out after ${ORDER_EVENT_PUBLISH_TIMEOUT_MS}ms`),
          ),
        ORDER_EVENT_PUBLISH_TIMEOUT_MS,
      );
      timer.unref?.();
    });

    void Promise.race([
      Promise.resolve().then(() =>
        this.trackingEventBus.publishOrderEvent(event),
      ),
      timeout,
    ])
      .catch((error: unknown) => {
        this.logger.warn(
          `Order event ${event.eventType} for shipment ${event.shipmentId} was not published: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        if (timer) {
          clearTimeout(timer);
        }
      });
  }
}
