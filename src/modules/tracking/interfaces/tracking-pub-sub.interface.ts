export type TrackingBroadcastPayload = {
  shipmentId: string;
  latitude: number;
  longitude: number;
  etaSeconds: number | null;
  timestamp: string;
};

export type TrackingPubSubMessage = {
  shipmentId: string;
  event: 'tracking:update';
  payload: TrackingBroadcastPayload;
};

export type TrackingPubSubHandler = (message: TrackingPubSubMessage) => void | Promise<void>;

export interface TrackingPubSub {
  publish(message: TrackingPubSubMessage): Promise<void>;
  registerHandler(handler: TrackingPubSubHandler): void;
}
