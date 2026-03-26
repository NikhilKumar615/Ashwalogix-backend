import {
  UseGuards,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { OrganizationRole, ShipmentStatus } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { AuthorizationService } from '../auth/authorization.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { AssignDriverDto } from './dto/assign-driver.dto';
import { CreateShipmentDto } from './dto/create-shipment.dto';
import { CreateProofOfDeliveryDto } from './dto/create-proof-of-delivery.dto';
import { CreateTrackingPointDto } from './dto/create-tracking-point.dto';
import { FailShipmentDto } from './dto/fail-shipment.dto';
import { ShipmentStatusActionDto } from './dto/shipment-status-action.dto';
import { StartTrackingSessionDto } from './dto/start-tracking-session.dto';
import { ShipmentsService } from './shipments.service';

@ApiTags('Shipments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('shipments')
export class ShipmentsController {
  constructor(
    private readonly shipmentsService: ShipmentsService,
    private readonly authorizationService: AuthorizationService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List shipments' })
  @ApiQuery({ name: 'organizationId', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ShipmentStatus })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
  )
  async listShipments(
    @CurrentUser() user: JwtPayload,
    @Query('organizationId') organizationId: string,
    @Query('status') status?: ShipmentStatus,
  ) {
    if (organizationId) {
      await this.authorizationService.assertOrganizationAccess(user, organizationId, [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
        OrganizationRole.WAREHOUSE,
      ]);
    }

    return this.shipmentsService.listShipments({
      organizationId,
      organizationIds: organizationId ? undefined : user.organizationIds,
      status,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get shipment details' })
  @ApiParam({ name: 'id', type: String })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
  )
  async getShipment(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    await this.authorizationService.assertShipmentAccess(user, id, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
        OrganizationRole.WAREHOUSE,
      ],
    });

    const shipment = await this.shipmentsService.getShipmentById(id);

    if (!shipment) {
      throw new NotFoundException(`Shipment ${id} not found`);
    }

    return shipment;
  }

  @Post()
  @ApiOperation({ summary: 'Create a shipment' })
  @ApiBody({ type: CreateShipmentDto })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
  )
  async createShipment(
    @Body() body: CreateShipmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(
      user,
      body.organizationId,
      [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
    );

    return this.shipmentsService.createShipment(body);
  }

  @Post(':id/assign-driver')
  @ApiOperation({ summary: 'Assign or reassign a driver to a shipment' })
  @ApiParam({ name: 'id', type: String })
  @ApiBody({ type: AssignDriverDto })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
  )
  async assignDriver(
    @Param('id') shipmentId: string,
    @Body() body: AssignDriverDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertShipmentAccess(user, shipmentId, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
    });
    await this.authorizationService.assertOrganizationAccess(
      user,
      body.organizationId,
      [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
    );

    return this.shipmentsService.assignDriver(shipmentId, body);
  }

  @Get(':id/timeline')
  @ApiOperation({ summary: 'Get shipment timeline/status events' })
  @ApiParam({ name: 'id', type: String })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
  )
  async getTimeline(
    @Param('id') shipmentId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertShipmentAccess(user, shipmentId, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
        OrganizationRole.WAREHOUSE,
      ],
    });

    return this.shipmentsService.getShipmentTimeline(shipmentId);
  }

  @Post(':id/tracking/start')
  @ApiOperation({ summary: 'Start a tracking session for a shipment' })
  @ApiParam({ name: 'id', type: String })
  @ApiBody({ type: StartTrackingSessionDto })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.DRIVER,
  )
  async startTrackingSession(
    @Param('id') shipmentId: string,
    @Body() body: StartTrackingSessionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(
      user,
      body.organizationId,
    );
    await this.authorizationService.assertShipmentAccess(user, shipmentId, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
      allowAssignedDriver: true,
    });

    return this.shipmentsService.startTrackingSession(shipmentId, body);
  }

  @Post(':id/tracking/points')
  @ApiOperation({ summary: 'Add a tracking point to the active shipment session' })
  @ApiParam({ name: 'id', type: String })
  @ApiBody({ type: CreateTrackingPointDto })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.DRIVER,
  )
  async addTrackingPoint(
    @Param('id') shipmentId: string,
    @Body() body: CreateTrackingPointDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(
      user,
      body.organizationId,
    );
    await this.authorizationService.assertShipmentAccess(user, shipmentId, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
      allowAssignedDriver: true,
    });

    return this.shipmentsService.addTrackingPoint(shipmentId, body);
  }

  @Get(':id/tracking/latest')
  @ApiOperation({ summary: 'Get latest live tracking point for a shipment' })
  @ApiParam({ name: 'id', type: String })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
    OrganizationRole.DRIVER,
  )
  async getLatestTrackingPoint(
    @Param('id') shipmentId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertShipmentAccess(user, shipmentId, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
        OrganizationRole.WAREHOUSE,
      ],
      allowAssignedDriver: true,
    });

    return this.shipmentsService.getLatestTrackingPoint(shipmentId);
  }

  @Get(':id/tracking/history')
  @ApiOperation({ summary: 'Get tracking history for a shipment' })
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
    OrganizationRole.DRIVER,
  )
  async getTrackingHistory(
    @Param('id') shipmentId: string,
    @Query('limit') limit: number | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertShipmentAccess(user, shipmentId, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
        OrganizationRole.WAREHOUSE,
      ],
      allowAssignedDriver: true,
    });

    return this.shipmentsService.getTrackingHistory(shipmentId, limit);
  }

  @Get(':id/tracking/status')
  @ApiOperation({ summary: 'Get current trip tracking status for a shipment' })
  @ApiParam({ name: 'id', type: String })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
    OrganizationRole.DRIVER,
  )
  async getTrackingStatus(
    @Param('id') shipmentId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertShipmentAccess(user, shipmentId, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
        OrganizationRole.WAREHOUSE,
      ],
      allowAssignedDriver: true,
    });

    return this.shipmentsService.getTrackingStatus(shipmentId);
  }

  @Post(':id/pod')
  @ApiOperation({ summary: 'Create POD metadata for a shipment' })
  @ApiParam({ name: 'id', type: String })
  @ApiBody({ type: CreateProofOfDeliveryDto })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.DRIVER,
  )
  async createProofOfDelivery(
    @Param('id') shipmentId: string,
    @Body() body: CreateProofOfDeliveryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(
      user,
      body.organizationId,
    );
    await this.authorizationService.assertShipmentAccess(user, shipmentId, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
      allowAssignedDriver: true,
    });

    return this.shipmentsService.createProofOfDelivery(shipmentId, body);
  }

  @Post(':id/plan')
  @ApiOperation({ summary: 'Move shipment from draft to planned' })
  @ApiParam({ name: 'id', type: String })
  @ApiBody({ type: ShipmentStatusActionDto })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
  )
  async planShipment(
    @Param('id') shipmentId: string,
    @Body() body: ShipmentStatusActionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(
      user,
      body.organizationId,
      [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
    );
    await this.authorizationService.assertShipmentAccess(user, shipmentId, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
    });

    return this.shipmentsService.planShipment(shipmentId, body);
  }

  @Post(':id/mark-at-pickup')
  @ApiOperation({ summary: 'Mark shipment as arrived at pickup' })
  @ApiParam({ name: 'id', type: String })
  @ApiBody({ type: ShipmentStatusActionDto })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.DRIVER,
  )
  async markAtPickup(
    @Param('id') shipmentId: string,
    @Body() body: ShipmentStatusActionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(
      user,
      body.organizationId,
    );
    await this.authorizationService.assertShipmentAccess(user, shipmentId, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
      allowAssignedDriver: true,
    });

    return this.shipmentsService.markAtPickup(shipmentId, body);
  }

  @Post(':id/confirm-pickup')
  @ApiOperation({ summary: 'Confirm shipment pickup completion' })
  @ApiParam({ name: 'id', type: String })
  @ApiBody({ type: ShipmentStatusActionDto })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.DRIVER,
  )
  async confirmPickup(
    @Param('id') shipmentId: string,
    @Body() body: ShipmentStatusActionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(
      user,
      body.organizationId,
    );
    await this.authorizationService.assertShipmentAccess(user, shipmentId, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
      allowAssignedDriver: true,
    });

    return this.shipmentsService.confirmPickup(shipmentId, body);
  }

  @Post(':id/mark-in-transit')
  @ApiOperation({ summary: 'Mark shipment as in transit' })
  @ApiParam({ name: 'id', type: String })
  @ApiBody({ type: ShipmentStatusActionDto })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.DRIVER,
  )
  async markInTransit(
    @Param('id') shipmentId: string,
    @Body() body: ShipmentStatusActionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(
      user,
      body.organizationId,
    );
    await this.authorizationService.assertShipmentAccess(user, shipmentId, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
      allowAssignedDriver: true,
    });

    return this.shipmentsService.markInTransit(shipmentId, body);
  }

  @Post(':id/mark-at-delivery')
  @ApiOperation({ summary: 'Mark shipment as arrived at delivery' })
  @ApiParam({ name: 'id', type: String })
  @ApiBody({ type: ShipmentStatusActionDto })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.DRIVER,
  )
  async markAtDelivery(
    @Param('id') shipmentId: string,
    @Body() body: ShipmentStatusActionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(
      user,
      body.organizationId,
    );
    await this.authorizationService.assertShipmentAccess(user, shipmentId, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
      allowAssignedDriver: true,
    });

    return this.shipmentsService.markAtDelivery(shipmentId, body);
  }

  @Post(':id/complete-delivery')
  @ApiOperation({ summary: 'Mark shipment delivery as completed' })
  @ApiParam({ name: 'id', type: String })
  @ApiBody({ type: ShipmentStatusActionDto })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.DRIVER,
  )
  async completeDelivery(
    @Param('id') shipmentId: string,
    @Body() body: ShipmentStatusActionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(
      user,
      body.organizationId,
    );
    await this.authorizationService.assertShipmentAccess(user, shipmentId, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
      allowAssignedDriver: true,
    });

    return this.shipmentsService.completeDelivery(shipmentId, body);
  }

  @Post(':id/complete')
  @ApiOperation({ summary: 'Close a delivered shipment as completed' })
  @ApiParam({ name: 'id', type: String })
  @ApiBody({ type: ShipmentStatusActionDto })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
  )
  async completeShipment(
    @Param('id') shipmentId: string,
    @Body() body: ShipmentStatusActionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(
      user,
      body.organizationId,
      [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
    );
    await this.authorizationService.assertShipmentAccess(user, shipmentId, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
    });

    return this.shipmentsService.completeShipment(shipmentId, body);
  }

  @Post(':id/fail')
  @ApiOperation({ summary: 'Mark shipment as failed / exception' })
  @ApiParam({ name: 'id', type: String })
  @ApiBody({ type: FailShipmentDto })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.DRIVER,
  )
  async failShipment(
    @Param('id') shipmentId: string,
    @Body() body: FailShipmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(
      user,
      body.organizationId,
    );
    await this.authorizationService.assertShipmentAccess(user, shipmentId, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
      allowAssignedDriver: true,
    });

    return this.shipmentsService.failShipment(shipmentId, body);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a shipment' })
  @ApiParam({ name: 'id', type: String })
  @ApiBody({ type: ShipmentStatusActionDto })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
  )
  async cancelShipment(
    @Param('id') shipmentId: string,
    @Body() body: ShipmentStatusActionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(
      user,
      body.organizationId,
      [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
    );
    await this.authorizationService.assertShipmentAccess(user, shipmentId, {
      allowedOrganizationRoles: [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
    });

    return this.shipmentsService.cancelShipment(shipmentId, body);
  }
}
