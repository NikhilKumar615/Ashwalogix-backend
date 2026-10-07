import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { OrganizationRole } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthorizationService } from '../auth/authorization.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { SectionAccess } from '../auth/decorators/section-access.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { DeleteResourceDto } from '../../shared/dto/delete-resource.dto';
import { CreateOrganizationUserDto } from './dto/create-organization-user.dto';
import { RegisterCompanyDriverDto } from './dto/register-company-driver.dto';
import { RegisterDispatcherDto } from './dto/register-dispatcher.dto';
import { RegisterOrganizationStaffDto } from './dto/register-organization-staff.dto';
import { UpdateOrganizationUserDto } from './dto/update-organization-user.dto';
import {
  OrganizationsService,
  type OrganizationActor,
} from './organizations.service';

@ApiTags('Organizations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@SectionAccess('users')
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly authorizationService: AuthorizationService,
  ) {}

  @Get(':organizationId/users')
  @ApiOperation({ summary: 'List users for an organization' })
  @ApiParam({ name: 'organizationId', type: String })
  @Roles(OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS)
  async listUsers(
    @Param('organizationId') organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(
      user,
      organizationId,
      [OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS],
    );

    return this.organizationsService.listUsers(organizationId);
  }

  @Get(':organizationId/users/:userId')
  @ApiOperation({ summary: 'Get one organization staff user' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'userId', type: String })
  @Roles(OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS)
  async getUserById(
    @Param('organizationId') organizationId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(
      user,
      organizationId,
      [OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS],
    );

    return this.organizationsService.getUserById(organizationId, userId);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('lookup/client-code/:clientCode')
  @ApiOperation({
    summary: 'Lookup an active organization by platform client code',
  })
  @ApiParam({ name: 'clientCode', type: String })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
  )
  async lookupOrganizationByClientCode(
    @Param('clientCode') clientCode: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const hasActiveOrganization =
      user.platformRole === 'SUPER_ADMIN' ||
      user.memberships?.some(
        (membership) => membership.organizationStatus === 'ACTIVE',
      );
    if (!user.organizationIds?.length && user.platformRole !== 'SUPER_ADMIN') {
      throw new NotFoundException('Organization not found');
    }
    if (!hasActiveOrganization) {
      throw new NotFoundException('Organization not found');
    }

    return this.organizationsService.lookupOrganizationByClientCode(clientCode);
  }

  @Post(':organizationId/users')
  @ApiOperation({
    summary:
      'Create a company user for dispatcher, operations, warehouse, driver, or another org admin',
  })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiBody({ type: CreateOrganizationUserDto })
  @Roles(OrganizationRole.ORG_ADMIN)
  async createOrganizationUser(
    @Param('organizationId') organizationId: string,
    @Body() body: CreateOrganizationUserDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(
      user,
      organizationId,
      [OrganizationRole.ORG_ADMIN],
    );

    return this.organizationsService.createOrganizationUser(
      organizationId,
      body,
      this.actor(user, organizationId),
    );
  }

  @Post(':organizationId/dispatchers')
  @ApiOperation({ summary: 'Register a dispatcher under an approved company' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiBody({ type: RegisterDispatcherDto })
  @Roles(OrganizationRole.ORG_ADMIN)
  async registerDispatcher(
    @Param('organizationId') organizationId: string,
    @Body() body: RegisterDispatcherDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(
      user,
      organizationId,
      [OrganizationRole.ORG_ADMIN],
    );

    return this.organizationsService.registerDispatcher(
      organizationId,
      body,
      this.actor(user, organizationId),
    );
  }

  @Post(':organizationId/warehouse-staff')
  @ApiOperation({
    summary: 'Register warehouse staff under an approved company',
  })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiBody({ type: RegisterOrganizationStaffDto })
  @Roles(OrganizationRole.ORG_ADMIN)
  async registerWarehouseStaff(
    @Param('organizationId') organizationId: string,
    @Body() body: RegisterOrganizationStaffDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(
      user,
      organizationId,
      [OrganizationRole.ORG_ADMIN],
    );

    return this.organizationsService.registerWarehouseStaff(
      organizationId,
      body,
      this.actor(user, organizationId),
    );
  }

  @Post(':organizationId/operations-staff')
  @ApiOperation({
    summary: 'Register operations staff under an approved company',
  })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiBody({ type: RegisterOrganizationStaffDto })
  @Roles(OrganizationRole.ORG_ADMIN)
  async registerOperationsStaff(
    @Param('organizationId') organizationId: string,
    @Body() body: RegisterOrganizationStaffDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(
      user,
      organizationId,
      [OrganizationRole.ORG_ADMIN],
    );

    return this.organizationsService.registerOperationsStaff(
      organizationId,
      body,
      this.actor(user, organizationId),
    );
  }

  @Post(':organizationId/drivers')
  @ApiOperation({
    summary: 'Register a company driver under an approved company',
  })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiBody({ type: RegisterCompanyDriverDto })
  @Roles(OrganizationRole.ORG_ADMIN)
  async registerCompanyDriver(
    @Param('organizationId') organizationId: string,
    @Body() body: RegisterCompanyDriverDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(
      user,
      organizationId,
      [OrganizationRole.ORG_ADMIN],
    );

    return this.organizationsService.registerCompanyDriver(
      organizationId,
      body,
      this.actor(user, organizationId),
    );
  }

  @Patch(':organizationId/users/:userId')
  @ApiOperation({ summary: 'Update an organization staff user' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'userId', type: String })
  @ApiBody({ type: UpdateOrganizationUserDto })
  @Roles(OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS)
  async updateOrganizationUser(
    @Param('organizationId') organizationId: string,
    @Param('userId') userId: string,
    @Body() body: UpdateOrganizationUserDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(
      user,
      organizationId,
      [OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS],
    );

    return this.organizationsService.updateOrganizationUser(
      organizationId,
      userId,
      body,
      this.actor(user, organizationId),
    );
  }

  @Delete(':organizationId/users/:userId')
  @ApiOperation({ summary: 'Remove an organization user with an audit reason' })
  @ApiBody({ type: DeleteResourceDto })
  @Roles(OrganizationRole.ORG_ADMIN)
  async deleteOrganizationUser(
    @Param('organizationId') organizationId: string,
    @Param('userId') userId: string,
    @Body() body: DeleteResourceDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(
      user,
      organizationId,
      [OrganizationRole.ORG_ADMIN],
    );
    return this.organizationsService.deleteOrganizationUser(
      organizationId,
      userId,
      body.reason,
      user.sub,
      this.authorizationService.isOrganizationAdmin(user, organizationId),
    );
  }

  /** Role-derived actor context; section access never makes someone an org admin. */
  private actor(user: JwtPayload, organizationId: string): OrganizationActor {
    return {
      userId: user.sub,
      isOrgAdmin: this.authorizationService.isOrganizationAdmin(
        user,
        organizationId,
      ),
      sectionAccess: this.authorizationService.getSectionAccess(
        user,
        organizationId,
      ),
    };
  }
}
