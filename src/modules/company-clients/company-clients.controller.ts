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
import { ClientStatus, OrganizationRole } from '@prisma/client';
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
import { CompanyClientsService } from './company-clients.service';
import { CreateCompanyClientDto } from './dto/create-company-client.dto';
import { CreateCompanyClientLocationDto } from './dto/create-company-client-location.dto';
import { UpdateCompanyClientDto } from './dto/update-company-client.dto';
import { UpdateCompanyClientLocationDto } from './dto/update-company-client-location.dto';

@ApiTags('Company Clients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('organizations/:organizationId/company-clients')
export class CompanyClientsController {
  constructor(
    private readonly companyClientsService: CompanyClientsService,
    private readonly authorizationService: AuthorizationService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List company clients for an organization' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiQuery({ name: 'status', required: false, enum: ClientStatus })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
  )
  async listCompanyClients(
    @Param('organizationId') organizationId: string,
    @Query('status') status: ClientStatus | undefined,
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

    return this.companyClientsService.listCompanyClients(
      organizationId,
      status,
    );
  }

  @Post()
  @ApiOperation({ summary: 'Create a company client for an organization' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiBody({ type: CreateCompanyClientDto })
  @Roles(OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS)
  async createCompanyClient(
    @Param('organizationId') organizationId: string,
    @Body() body: CreateCompanyClientDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(
      user,
      organizationId,
      [OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS],
    );

    return this.companyClientsService.createCompanyClient(organizationId, body);
  }

  @Get(':companyClientId')
  @ApiOperation({ summary: 'Get company client details' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'companyClientId', type: String })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
  )
  async getCompanyClientById(
    @Param('organizationId') organizationId: string,
    @Param('companyClientId') companyClientId: string,
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

    return this.companyClientsService.getCompanyClientById(
      organizationId,
      companyClientId,
    );
  }

  @Patch(':companyClientId')
  @ApiOperation({ summary: 'Update company client details' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'companyClientId', type: String })
  @ApiBody({ type: UpdateCompanyClientDto })
  @Roles(OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS)
  async updateCompanyClient(
    @Param('organizationId') organizationId: string,
    @Param('companyClientId') companyClientId: string,
    @Body() body: UpdateCompanyClientDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(
      user,
      organizationId,
      [OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS],
    );

    return this.companyClientsService.updateCompanyClient(
      organizationId,
      companyClientId,
      body,
    );
  }

  @Get(':companyClientId/locations')
  @ApiOperation({ summary: 'List locations for a company client' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'companyClientId', type: String })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
  )
  async listCompanyClientLocations(
    @Param('organizationId') organizationId: string,
    @Param('companyClientId') companyClientId: string,
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

    return this.companyClientsService.listCompanyClientLocations(
      organizationId,
      companyClientId,
    );
  }

  @Post(':companyClientId/locations')
  @ApiOperation({ summary: 'Create a location for a company client' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'companyClientId', type: String })
  @ApiBody({ type: CreateCompanyClientLocationDto })
  @Roles(OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS)
  async createCompanyClientLocation(
    @Param('organizationId') organizationId: string,
    @Param('companyClientId') companyClientId: string,
    @Body() body: CreateCompanyClientLocationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(
      user,
      organizationId,
      [OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS],
    );

    return this.companyClientsService.createCompanyClientLocation(
      organizationId,
      companyClientId,
      body,
    );
  }

  @Patch(':companyClientId/locations/:locationId')
  @ApiOperation({ summary: 'Update a company client location' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'companyClientId', type: String })
  @ApiParam({ name: 'locationId', type: String })
  @ApiBody({ type: UpdateCompanyClientLocationDto })
  @Roles(OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS)
  async updateCompanyClientLocation(
    @Param('organizationId') organizationId: string,
    @Param('companyClientId') companyClientId: string,
    @Param('locationId') locationId: string,
    @Body() body: UpdateCompanyClientLocationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(
      user,
      organizationId,
      [OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS],
    );

    return this.companyClientsService.updateCompanyClientLocation(
      organizationId,
      companyClientId,
      locationId,
      body,
    );
  }
}
