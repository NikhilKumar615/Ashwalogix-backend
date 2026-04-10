import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { DriverStatus, OrganizationRole } from '@prisma/client';
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
import { RegenerateDriverPasswordDto } from './dto/regenerate-driver-password.dto';
import { UpdateDriverDto } from './dto/update-driver.dto';
import { DriversService } from './drivers.service';

@ApiTags('Drivers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('drivers')
export class DriversController {
  constructor(
    private readonly driversService: DriversService,
    private readonly authorizationService: AuthorizationService,
  ) {}

  @Get('organizations/:organizationId/drivers')
  @ApiOperation({ summary: 'List drivers for an organization' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiQuery({ name: 'status', required: false, enum: DriverStatus })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
  )
  async listDrivers(
    @Param('organizationId') organizationId: string,
    @Query('status') status: DriverStatus | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(user, organizationId, [
      OrganizationRole.ORG_ADMIN,
      OrganizationRole.DISPATCHER,
      OrganizationRole.OPERATIONS,
      OrganizationRole.WAREHOUSE,
    ]);

    return this.driversService.listDrivers(organizationId, status);
  }

  @Get('organizations/:organizationId/drivers/:driverId')
  @ApiOperation({ summary: 'Get one driver by id' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'driverId', type: String })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
    OrganizationRole.DRIVER,
  )
  async getDriverById(
    @Param('organizationId') organizationId: string,
    @Param('driverId') driverId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertDriverAccess(
      user,
      driverId,
      organizationId,
      [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
        OrganizationRole.WAREHOUSE,
      ],
    );

    return this.driversService.getDriverById(driverId, organizationId);
  }

  @Patch('organizations/:organizationId/drivers/:driverId')
  @ApiOperation({ summary: 'Update a driver profile' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'driverId', type: String })
  @ApiBody({ type: UpdateDriverDto })
  @Roles(OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS)
  async updateDriver(
    @Param('organizationId') organizationId: string,
    @Param('driverId') driverId: string,
    @Body() body: UpdateDriverDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(user, organizationId, [
      OrganizationRole.ORG_ADMIN,
      OrganizationRole.OPERATIONS,
    ]);

    return this.driversService.updateDriver(driverId, organizationId, body);
  }

  @Post('organizations/:organizationId/drivers/:driverId/regenerate-password')
  @ApiOperation({ summary: 'Regenerate a temporary password for a driver' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'driverId', type: String })
  @ApiBody({ type: RegenerateDriverPasswordDto })
  @Roles(OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS)
  async regenerateDriverPassword(
    @Param('organizationId') organizationId: string,
    @Param('driverId') driverId: string,
    @Body() body: RegenerateDriverPasswordDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(user, organizationId, [
      OrganizationRole.ORG_ADMIN,
      OrganizationRole.OPERATIONS,
    ]);

    return this.driversService.regeneratePassword(
      driverId,
      organizationId,
      body.password,
    );
  }

  @Post('organizations/:organizationId/drivers/normalize-codes')
  @ApiOperation({ summary: 'Normalize legacy driver codes to the strict company format' })
  @ApiParam({ name: 'organizationId', type: String })
  @Roles(OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS)
  async normalizeDriverCodes(
    @Param('organizationId') organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(user, organizationId, [
      OrganizationRole.ORG_ADMIN,
      OrganizationRole.OPERATIONS,
    ]);

    return this.driversService.normalizeDriverCodes(organizationId);
  }

  @Get(':driverId/assigned-shipments')
  @ApiOperation({ summary: 'Get active assigned shipments for a driver' })
  @ApiParam({ name: 'driverId', type: String })
  @ApiQuery({ name: 'organizationId', required: true, type: String })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.DRIVER,
  )
  async getAssignedShipments(
    @Param('driverId') driverId: string,
    @Query('organizationId') organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertDriverAccess(
      user,
      driverId,
      organizationId,
      [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
    );

    return this.driversService.getAssignedShipments(driverId, organizationId);
  }

  @Get(':driverId/shipment-history')
  @ApiOperation({ summary: 'Get shipment history for a driver' })
  @ApiParam({ name: 'driverId', type: String })
  @ApiQuery({ name: 'organizationId', required: true, type: String })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.DRIVER,
  )
  async getShipmentHistory(
    @Param('driverId') driverId: string,
    @Query('organizationId') organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertDriverAccess(
      user,
      driverId,
      organizationId,
      [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.DISPATCHER,
        OrganizationRole.OPERATIONS,
      ],
    );

    return this.driversService.getShipmentHistory(driverId, organizationId);
  }
}
