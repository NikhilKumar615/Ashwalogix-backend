import { Injectable } from '@nestjs/common';

type ScalarState = {
  estimate: number;
  variance: number;
};

type KalmanState = {
  latitude: ScalarState;
  longitude: ScalarState;
  lastUpdatedAt: number;
};

@Injectable()
export class TrackingKalmanService {
  private readonly stateByShipment = new Map<string, KalmanState>();
  private readonly minimumVariance = 1e-8;
  private readonly processNoise = 1e-6;

  update(
    shipmentId: string,
    measurement: { latitude: number; longitude: number; accuracy?: number },
    timestamp = Date.now(),
  ) {
    const measurementVariance = this.resolveMeasurementVariance(
      measurement.accuracy,
    );
    const existingState = this.stateByShipment.get(shipmentId);

    if (!existingState) {
      const initialState: KalmanState = {
        latitude: {
          estimate: measurement.latitude,
          variance: measurementVariance,
        },
        longitude: {
          estimate: measurement.longitude,
          variance: measurementVariance,
        },
        lastUpdatedAt: timestamp,
      };

      this.stateByShipment.set(shipmentId, initialState);

      return {
        latitude: measurement.latitude,
        longitude: measurement.longitude,
      };
    }

    const timeDeltaSeconds = Math.max(
      (timestamp - existingState.lastUpdatedAt) / 1000,
      1,
    );
    const predictedLatitudeVariance =
      existingState.latitude.variance + this.processNoise * timeDeltaSeconds;
    const predictedLongitudeVariance =
      existingState.longitude.variance + this.processNoise * timeDeltaSeconds;

    const nextLatitude = this.applyKalmanStep(
      existingState.latitude.estimate,
      predictedLatitudeVariance,
      measurement.latitude,
      measurementVariance,
    );
    const nextLongitude = this.applyKalmanStep(
      existingState.longitude.estimate,
      predictedLongitudeVariance,
      measurement.longitude,
      measurementVariance,
    );

    this.stateByShipment.set(shipmentId, {
      latitude: nextLatitude,
      longitude: nextLongitude,
      lastUpdatedAt: timestamp,
    });

    return {
      latitude: nextLatitude.estimate,
      longitude: nextLongitude.estimate,
    };
  }

  clear(shipmentId: string) {
    this.stateByShipment.delete(shipmentId);
  }

  hasState(shipmentId: string) {
    return this.stateByShipment.has(shipmentId);
  }

  private applyKalmanStep(
    predictedEstimate: number,
    predictedVariance: number,
    measurement: number,
    measurementVariance: number,
  ): ScalarState {
    const kalmanGain =
      predictedVariance / (predictedVariance + measurementVariance);
    const estimate =
      predictedEstimate + kalmanGain * (measurement - predictedEstimate);
    const variance = Math.max(
      (1 - kalmanGain) * predictedVariance,
      this.minimumVariance,
    );

    return { estimate, variance };
  }

  private resolveMeasurementVariance(accuracy?: number) {
    const safeAccuracyMetres = Math.max(accuracy ?? 15, 5);
    const accuracyInDegrees = safeAccuracyMetres / 111_320;

    return Math.max(accuracyInDegrees ** 2, this.minimumVariance);
  }
}
