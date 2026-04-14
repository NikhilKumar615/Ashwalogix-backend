import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { StringValue } from 'ms';
import { KafkaModule } from '../../shared/kafka/kafka.module';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ShipmentsModule } from '../shipments/shipments.module';
import { TRACKING_PUB_SUB } from './tracking.constants';
import { TrackingController } from './tracking.controller';
import { TrackingDbSinkConsumerService } from './tracking-db-sink-consumer.service';
import { TrackingGateway } from './tracking.gateway';
import { TrackingEtaCacheService } from './tracking-eta-cache.service';
import { TrackingAuthService } from './tracking-auth.service';
import { TrackingEtaService } from './tracking-eta.service';
import { TrackingEtaEngineConsumerService } from './tracking-eta-engine-consumer.service';
import { TrackingFanoutService } from './tracking-fanout.service';
import { TrackingKalmanService } from './tracking-kalman.service';
import { TrackingNotificationConsumerService } from './tracking-notification-consumer.service';
import { TrackingPubSubService } from './tracking-pub-sub.service';
import { TrackingRoadEtaService } from './tracking-road-eta.service';
import { TrackingRoomService } from './tracking-room.service';
import { TrackingService } from './tracking.service';
import { TrackingTestingService } from './tracking-testing.service';
import { TrackingValidationService } from './tracking-validation.service';

@Module({
  imports: [
    AuthModule,
    KafkaModule,
    PrismaModule,
    ShipmentsModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET') ?? 'dev-secret',
        signOptions: {
          expiresIn:
            (configService.get<string>('JWT_EXPIRES_IN') ?? '1d') as StringValue,
        },
      }),
    }),
  ],
  controllers: [TrackingController],
  providers: [
    TrackingGateway,
    TrackingAuthService,
    TrackingKalmanService,
    TrackingEtaService,
    TrackingEtaCacheService,
    TrackingRoadEtaService,
    TrackingRoomService,
    TrackingService,
    TrackingTestingService,
    TrackingFanoutService,
    TrackingDbSinkConsumerService,
    TrackingEtaEngineConsumerService,
    TrackingNotificationConsumerService,
    TrackingPubSubService,
    TrackingValidationService,
    {
      provide: TRACKING_PUB_SUB,
      useExisting: TrackingPubSubService,
    },
  ],
  exports: [TrackingService],
})
export class TrackingModule {}
