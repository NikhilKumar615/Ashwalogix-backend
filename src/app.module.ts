import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CompanyClientsModule } from './modules/company-clients/company-clients.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { DriverRealtimeModule } from './modules/driver-realtime/driver-realtime.module';
import { DriversModule } from './modules/drivers/drivers.module';
import { HealthModule } from './modules/health/health.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { PodModule } from './modules/pod/pod.module';
import { PlatformSettingsModule } from './modules/platform-settings/platform-settings.module';
import { ShipmentsModule } from './modules/shipments/shipments.module';
import { TrackingModule } from './modules/tracking/tracking.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';
import { WarehouseModule } from './modules/warehouse/warehouse.module';
import { HttpThrottlerGuard } from './shared/config/http-throttler.guard';
import { GlobalExceptionFilter } from './shared/filters/prisma-exception.filter';
import { KafkaModule } from './shared/kafka/kafka.module';
import { PrismaModule } from './shared/prisma/prisma.module';

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    // Global per-IP rate limit; sensitive routes tighten it with @Throttle.
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'default',
          ttl: positiveNumber(process.env.RATE_LIMIT_TTL_MS, 60_000),
          limit: positiveNumber(process.env.RATE_LIMIT_MAX, 300),
        },
      ],
      errorMessage:
        'Too many requests. Please slow down and try again shortly.',
    }),
    PrismaModule,
    KafkaModule,
    HealthModule,
    AuthModule,
    OrganizationsModule,
    CompanyClientsModule,
    DriversModule,
    DriverRealtimeModule,
    VehiclesModule,
    ShipmentsModule,
    TrackingModule,
    DocumentsModule,
    PodModule,
    PlatformSettingsModule,
    WarehouseModule,
    NotificationsModule,
    AuditModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: HttpThrottlerGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
