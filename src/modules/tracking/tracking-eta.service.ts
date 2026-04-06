import { Injectable } from '@nestjs/common';

const EARTH_RADIUS_KM = 6371;
const AVERAGE_BIKE_SPEED_KMH = 30;

@Injectable()
export class TrackingEtaService {
  calculateEtaSeconds(
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
  ) {
    const distanceKm = this.calculateHaversineDistanceKm(origin, destination);
    const etaHours = distanceKm / AVERAGE_BIKE_SPEED_KMH;

    return Math.max(Math.round(etaHours * 3600), 0);
  }

  private calculateHaversineDistanceKm(
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
  ) {
    const latitudeDelta = this.toRadians(destination.latitude - origin.latitude);
    const longitudeDelta = this.toRadians(
      destination.longitude - origin.longitude,
    );
    const originLatitude = this.toRadians(origin.latitude);
    const destinationLatitude = this.toRadians(destination.latitude);

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
