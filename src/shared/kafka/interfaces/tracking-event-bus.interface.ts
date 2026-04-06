export type RiderLocationEvent = {
  eventId: string;
  shipmentId: string;
  organizationId: string;
  riderUserId: string;
  destination: {
    latitude: number;
    longitude: number;
  };
  location: {
    latitude: number;
    longitude: number;
    accuracy?: number;
    speed?: number;
    heading?: number;
  };
  timestamp: string;
};

export type OrderEventMessage = {
  eventId: string;
  shipmentId: string;
  organizationId: string;
  eventType: string;
  notes?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  eventTime: string;
  metadata?: unknown;
};

export type RiderLocationHandler = (
  event: RiderLocationEvent,
) => Promise<void> | void;
export type OrderEventHandler = (
  event: OrderEventMessage,
) => Promise<void> | void;

export interface TrackingEventBus {
  publishRiderLocation(event: RiderLocationEvent): Promise<void>;
  publishOrderEvent(event: OrderEventMessage): Promise<void>;
  registerRiderLocationConsumer(
    groupId: string,
    handler: RiderLocationHandler,
  ): Promise<void>;
  registerOrderEventConsumer(
    groupId: string,
    handler: OrderEventHandler,
  ): Promise<void>;
}
