import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CompanyClientsController } from './company-clients.controller';
import { CompanyClientsService } from './company-clients.service';

@Module({
  imports: [AuthModule],
  controllers: [CompanyClientsController],
  providers: [CompanyClientsService],
  exports: [CompanyClientsService],
})
export class CompanyClientsModule {}
