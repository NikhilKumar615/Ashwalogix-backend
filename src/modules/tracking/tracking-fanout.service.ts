import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { TRACKING_PUB_SUB } from './tracking.constants';
import type { TrackingPubSub } from './interfaces/tracking-pub-sub.interface';
import { TrackingRoomService } from './tracking-room.service';

@Injectable()
export class TrackingFanoutService implements OnModuleInit {
  constructor(
    @Inject(TRACKING_PUB_SUB)
    private readonly trackingPubSub: TrackingPubSub,
    private readonly trackingRoomService: TrackingRoomService,
  ) {}

  onModuleInit() {
    this.trackingPubSub.registerHandler((message) => {
      if (message.event !== 'tracking:update') {
        return;
      }

      this.trackingRoomService.broadcastTrackingUpdate(
        message.shipmentId,
        message.payload,
      );
    });
  }
}
