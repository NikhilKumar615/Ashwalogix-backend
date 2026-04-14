import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { OrganizationRole } from '@prisma/client';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CreateDriverTrackingTokenDto } from './dto/create-driver-tracking-token.dto';
import { CreateTrackingTestTokenDto } from './dto/create-tracking-test-token.dto';
import { PublishTestOrderEventDto } from './dto/publish-test-order-event.dto';
import { TrackingTestingService } from './tracking-testing.service';

@ApiTags('Tracking')
@Controller('tracking')
export class TrackingController {
  constructor(private readonly trackingTestingService: TrackingTestingService) {}

  @Get('socket-contract')
  @ApiOperation({
    summary: 'Get the live tracking WebSocket contract and event names for manual testing',
  })
  getSocketContract() {
    return this.trackingTestingService.getSocketContract();
  }

  @Post('test-token')
  @ApiOperation({
    summary: 'Generate a tracking JWT for Swagger/manual WebSocket testing',
  })
  @ApiBody({ type: CreateTrackingTestTokenDto })
  createTestToken(@Body() body: CreateTrackingTestTokenDto) {
    return this.trackingTestingService.createToken(body);
  }

  @Post('driver-token')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Generate a rider tracking JWT for the authenticated driver app',
  })
  @ApiBody({ type: CreateDriverTrackingTokenDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.DRIVER,
  )
  createDriverToken(
    @CurrentUser() user: JwtPayload,
    @Body() body: CreateDriverTrackingTokenDto,
  ) {
    return this.trackingTestingService.createDriverToken(user, body);
  }

  @Get('kafka-contract')
  @ApiOperation({
    summary: 'Get Kafka topics and consumer responsibilities for tracking Phase 5',
  })
  getKafkaContract() {
    return this.trackingTestingService.getKafkaContract();
  }

  @Post('test-order-event')
  @ApiOperation({
    summary: 'Publish a test order.events Kafka message for notification-consumer testing',
  })
  @ApiBody({ type: PublishTestOrderEventDto })
  publishTestOrderEvent(@Body() body: PublishTestOrderEventDto) {
    return this.trackingTestingService.publishTestOrderEvent(body);
  }
}
