import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { StringValue } from 'ms';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DriverRealtimeGateway } from './driver-realtime.gateway';
import { DriverRealtimeService } from './driver-realtime.service';
import { jwtSecret } from '../../shared/config/runtime-security';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: jwtSecret(configService),
        signOptions: {
          expiresIn:
            (configService.get<string>('JWT_EXPIRES_IN') ?? '1d') as StringValue,
        },
      }),
    }),
  ],
  providers: [DriverRealtimeGateway, DriverRealtimeService],
  exports: [DriverRealtimeService],
})
export class DriverRealtimeModule {}
