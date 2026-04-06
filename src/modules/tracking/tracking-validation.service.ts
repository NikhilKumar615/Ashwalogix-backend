import { Injectable } from '@nestjs/common';
import { TrackingLocationUpdateDto } from './dto/tracking-location-update.dto';

type GoodTrackingPoint = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  timestamp: number;
};

type TrackingValidationResult = {
  location: TrackingLocationUpdateDto;
  accepted: boolean;
  rejectionReason?: 'accuracy' | 'speed';
};

const MAX_ACCEPTED_ACCURACY_METRES = 50;
const MAX_ACCEPTED_SPEED_KMH = 80;
const EARTH_RADIUS_KM = 6371;

@Injectable()
export class TrackingValidationService {
  private readonly lastGoodPointByShipment = new Map<string, GoodTrackingPoint>();

  validate(
    shipmentId: string,
    location: TrackingLocationUpdateDto,
    eventTimestamp: number,
  ): TrackingValidationResult {
    const lastGoodPoint = this.lastGoodPointByShipment.get(shipmentId);

    if (
      typeof location.accuracy === 'number' &&
      location.accuracy > MAX_ACCEPTED_ACCURACY_METRES
    ) {
      return this.buildRejectedResult(lastGoodPoint, 'accuracy');
    }

    if (lastGoodPoint) {
      const impliedSpeedKmh = this.calculateImpliedSpeedKmh(
        lastGoodPoint,
        location,
        eventTimestamp,
      );

      if (impliedSpeedKmh > MAX_ACCEPTED_SPEED_KMH) {
        return this.buildRejectedResult(lastGoodPoint, 'speed');
      }
    }

    const acceptedLocation: TrackingLocationUpdateDto = {
      ...location,
      timestamp: new Date(eventTimestamp).toISOString(),
    };

    this.lastGoodPointByShipment.set(shipmentId, {
      latitude: acceptedLocation.latitude,
      longitude: acceptedLocation.longitude,
      accuracy: acceptedLocation.accuracy,
      speed: acceptedLocation.speed,
      heading: acceptedLocation.heading,
      timestamp: eventTimestamp,
    });

    return {
      location: acceptedLocation,
      accepted: true,
    };
  }

  rememberGoodOutput(
    shipmentId: string,
    location: {
      latitude: number;
      longitude: number;
      accuracy?: number;
      speed?: number;
      heading?: number;
    },
    eventTimestamp: number,
  ) {
    this.lastGoodPointByShipment.set(shipmentId, {
      ...location,
      timestamp: eventTimestamp,
    });
  }

  clear(shipmentId: string) {
    this.lastGoodPointByShipment.delete(shipmentId);
  }

  hasState(shipmentId: string) {
    return this.lastGoodPointByShipment.has(shipmentId);
  }

  private buildRejectedResult(
    lastGoodPoint: GoodTrackingPoint | undefined,
    reason: 'accuracy' | 'speed',
  ): TrackingValidationResult {
    if (!lastGoodPoint) {
      return {
        location: {
          latitude: 0,
          longitude: 0,
        },
        accepted: false,
        rejectionReason: reason,
      };
    }

    return {
      location: {
        latitude: lastGoodPoint.latitude,
        longitude: lastGoodPoint.longitude,
        accuracy: lastGoodPoint.accuracy,
        speed: lastGoodPoint.speed,
        heading: lastGoodPoint.heading,
        timestamp: new Date(lastGoodPoint.timestamp).toISOString(),
      },
      accepted: false,
      rejectionReason: reason,
    };
  }

  private calculateImpliedSpeedKmh(
    lastGoodPoint: GoodTrackingPoint,
    location: TrackingLocationUpdateDto,
    eventTimestamp: number,
  ) {
    const hoursElapsed = (eventTimestamp - lastGoodPoint.timestamp) / 3_600_000;

    if (hoursElapsed <= 0) {
      return Number.POSITIVE_INFINITY;
    }

    const distanceKm = this.calculateDistanceKm(
      lastGoodPoint.latitude,
      lastGoodPoint.longitude,
      location.latitude,
      location.longitude,
    );

    return distanceKm / hoursElapsed;
  }

  private calculateDistanceKm(
    startLatitude: number,
    startLongitude: number,
    endLatitude: number,
    endLongitude: number,
  ) {
    const latitudeDelta = this.toRadians(endLatitude - startLatitude);
    const longitudeDelta = this.toRadians(endLongitude - startLongitude);
    const originLatitude = this.toRadians(startLatitude);
    const destinationLatitude = this.toRadians(endLatitude);

    const haversine =
      Math.sin(latitudeDelta / 2) ** 2 +
      Math.cos(originLatitude) *
        Math.cos(destinationLatitude) *
        Math.sin(longitudeDelta / 2) ** 2;

    return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  }

  private toRadians(value: number) {
    return (value * Math.PI) / 180;
  }
}
