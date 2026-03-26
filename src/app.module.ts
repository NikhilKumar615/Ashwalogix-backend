import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CompanyClientsModule } from './modules/company-clients/company-clients.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { DriversModule } from './modules/drivers/drivers.module';
import { HealthModule } from './modules/health/health.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { PodModule } from './modules/pod/pod.module';
import { ShipmentsModule } from './modules/shipments/shipments.module';
import { TrackingModule } from './modules/tracking/tracking.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';
import { WarehouseModule } from './modules/warehouse/warehouse.module';
import { PrismaModule } from './shared/prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PrismaModule,
    HealthModule,
    AuthModule,
    OrganizationsModule,
    CompanyClientsModule,
    DriversModule,
    VehiclesModule,
    ShipmentsModule,
    TrackingModule,
    DocumentsModule,
    PodModule,
    WarehouseModule,
    NotificationsModule,
    AuditModule,
  ],
})
export class AppModule {}
