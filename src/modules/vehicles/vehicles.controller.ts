import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OrganizationRole, VehicleStatus } from '@prisma/client';
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
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { VehiclesService } from './vehicles.service';

@ApiTags('Vehicles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('organizations/:organizationId/vehicles')
export class VehiclesController {
  constructor(
    private readonly vehiclesService: VehiclesService,
    private readonly authorizationService: AuthorizationService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List vehicles for an organization' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiQuery({ name: 'status', required: false, enum: VehicleStatus })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
  )
  async listVehicles(
    @Param('organizationId') organizationId: string,
    @Query('status') status: VehicleStatus | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(
      user,
      organizationId,
      [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
    );

    return this.vehiclesService.listVehicles(organizationId, status);
  }

  @Post()
  @ApiOperation({ summary: 'Create a vehicle for an organization' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiBody({ type: CreateVehicleDto })
  @Roles(OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS)
  async createVehicle(
    @Param('organizationId') organizationId: string,
    @Body() body: CreateVehicleDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(
      user,
      organizationId,
      [OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS],
    );

    return this.vehiclesService.createVehicle(organizationId, body);
  }

  @Get(':vehicleId')
  @ApiOperation({ summary: 'Get vehicle details' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'vehicleId', type: String })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
  )
  async getVehicleById(
    @Param('organizationId') organizationId: string,
    @Param('vehicleId') vehicleId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(
      user,
      organizationId,
      [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
    );

    return this.vehiclesService.getVehicleById(organizationId, vehicleId);
  }

  @Patch(':vehicleId')
  @ApiOperation({ summary: 'Update a vehicle' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'vehicleId', type: String })
  @ApiBody({ type: UpdateVehicleDto })
  @Roles(OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS)
  async updateVehicle(
    @Param('organizationId') organizationId: string,
    @Param('vehicleId') vehicleId: string,
    @Body() body: UpdateVehicleDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(
      user,
      organizationId,
      [OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS],
    );

    return this.vehiclesService.updateVehicle(organizationId, vehicleId, body);
  }
}
