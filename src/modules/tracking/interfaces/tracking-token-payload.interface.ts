export type TrackingRole = 'rider' | 'customer';

export type TrackingTokenPayload = {
  sub: string;
  shipmentId: string;
  organizationId: string;
  role: TrackingRole;
  destination: {
    latitude: number;
    longitude: number;
  };
  email?: string;
  iat?: number;
  exp?: number;
};
