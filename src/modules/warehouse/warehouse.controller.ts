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
import {
  InventoryItemStatus,
  OrganizationRole,
  WarehouseStatus,
} from '@prisma/client';
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
import { CreateInventoryItemDto } from './dto/create-inventory-item.dto';
import { CreateInventoryMovementDto } from './dto/create-inventory-movement.dto';
import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { UpdateInventoryItemDto } from './dto/update-inventory-item.dto';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto';
import { WarehouseService } from './warehouse.service';

@ApiTags('Warehouse')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('organizations/:organizationId')
export class WarehouseController {
  constructor(
    private readonly warehouseService: WarehouseService,
    private readonly authorizationService: AuthorizationService,
  ) {}

  @Get('warehouses')
  @ApiOperation({ summary: 'List warehouses for an organization' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiQuery({ name: 'status', required: false, enum: WarehouseStatus })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
    OrganizationRole.DISPATCHER,
  )
  async listWarehouses(
    @Param('organizationId') organizationId: string,
    @Query('status') status: WarehouseStatus | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(user, organizationId, [
      OrganizationRole.ORG_ADMIN,
      OrganizationRole.OPERATIONS,
      OrganizationRole.WAREHOUSE,
      OrganizationRole.DISPATCHER,
    ]);

    return this.warehouseService.listWarehouses(organizationId, status);
  }

  @Post('warehouses')
  @ApiOperation({ summary: 'Create a warehouse' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiBody({ type: CreateWarehouseDto })
  @Roles(OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS)
  async createWarehouse(
    @Param('organizationId') organizationId: string,
    @Body() body: CreateWarehouseDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(user, organizationId, [
      OrganizationRole.ORG_ADMIN,
      OrganizationRole.OPERATIONS,
    ]);

    return this.warehouseService.createWarehouse(organizationId, body);
  }

  @Get('warehouses/:warehouseId')
  @ApiOperation({ summary: 'Get warehouse details' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'warehouseId', type: String })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
    OrganizationRole.DISPATCHER,
  )
  async getWarehouseById(
    @Param('organizationId') organizationId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(user, organizationId, [
      OrganizationRole.ORG_ADMIN,
      OrganizationRole.OPERATIONS,
      OrganizationRole.WAREHOUSE,
      OrganizationRole.DISPATCHER,
    ]);

    return this.warehouseService.getWarehouseById(organizationId, warehouseId);
  }

  @Patch('warehouses/:warehouseId')
  @ApiOperation({ summary: 'Update a warehouse' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'warehouseId', type: String })
  @ApiBody({ type: UpdateWarehouseDto })
  @Roles(OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS)
  async updateWarehouse(
    @Param('organizationId') organizationId: string,
    @Param('warehouseId') warehouseId: string,
    @Body() body: UpdateWarehouseDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(user, organizationId, [
      OrganizationRole.ORG_ADMIN,
      OrganizationRole.OPERATIONS,
    ]);

    return this.warehouseService.updateWarehouse(
      organizationId,
      warehouseId,
      body,
    );
  }

  @Get('inventory-items')
  @ApiOperation({ summary: 'List inventory items for an organization' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiQuery({ name: 'status', required: false, enum: InventoryItemStatus })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
    OrganizationRole.DISPATCHER,
  )
  async listInventoryItems(
    @Param('organizationId') organizationId: string,
    @Query('status') status: InventoryItemStatus | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(user, organizationId, [
      OrganizationRole.ORG_ADMIN,
      OrganizationRole.OPERATIONS,
      OrganizationRole.WAREHOUSE,
      OrganizationRole.DISPATCHER,
    ]);

    return this.warehouseService.listInventoryItems(organizationId, status);
  }

  @Post('inventory-items')
  @ApiOperation({ summary: 'Create an inventory item' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiBody({ type: CreateInventoryItemDto })
  @Roles(OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS, OrganizationRole.WAREHOUSE)
  async createInventoryItem(
    @Param('organizationId') organizationId: string,
    @Body() body: CreateInventoryItemDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(user, organizationId, [
      OrganizationRole.ORG_ADMIN,
      OrganizationRole.OPERATIONS,
      OrganizationRole.WAREHOUSE,
    ]);

    return this.warehouseService.createInventoryItem(organizationId, body);
  }

  @Get('inventory-items/:inventoryItemId')
  @ApiOperation({ summary: 'Get inventory item details' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'inventoryItemId', type: String })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
    OrganizationRole.DISPATCHER,
  )
  async getInventoryItemById(
    @Param('organizationId') organizationId: string,
    @Param('inventoryItemId') inventoryItemId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(user, organizationId, [
      OrganizationRole.ORG_ADMIN,
      OrganizationRole.OPERATIONS,
      OrganizationRole.WAREHOUSE,
      OrganizationRole.DISPATCHER,
    ]);

    return this.warehouseService.getInventoryItemById(
      organizationId,
      inventoryItemId,
    );
  }

  @Patch('inventory-items/:inventoryItemId')
  @ApiOperation({ summary: 'Update an inventory item' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'inventoryItemId', type: String })
  @ApiBody({ type: UpdateInventoryItemDto })
  @Roles(OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS, OrganizationRole.WAREHOUSE)
  async updateInventoryItem(
    @Param('organizationId') organizationId: string,
    @Param('inventoryItemId') inventoryItemId: string,
    @Body() body: UpdateInventoryItemDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(user, organizationId, [
      OrganizationRole.ORG_ADMIN,
      OrganizationRole.OPERATIONS,
      OrganizationRole.WAREHOUSE,
    ]);

    return this.warehouseService.updateInventoryItem(
      organizationId,
      inventoryItemId,
      body,
    );
  }

  @Get('warehouses/:warehouseId/stock')
  @ApiOperation({ summary: 'Get stock snapshot for a warehouse' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'warehouseId', type: String })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
    OrganizationRole.DISPATCHER,
  )
  async getWarehouseStock(
    @Param('organizationId') organizationId: string,
    @Param('warehouseId') warehouseId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(user, organizationId, [
      OrganizationRole.ORG_ADMIN,
      OrganizationRole.OPERATIONS,
      OrganizationRole.WAREHOUSE,
      OrganizationRole.DISPATCHER,
    ]);

    return this.warehouseService.getWarehouseStock(organizationId, warehouseId);
  }

  @Get('inventory-movements')
  @ApiOperation({ summary: 'List inventory movements' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiQuery({ name: 'warehouseId', required: false, type: String })
  @ApiQuery({ name: 'inventoryItemId', required: false, type: String })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
    OrganizationRole.DISPATCHER,
  )
  async listInventoryMovements(
    @Param('organizationId') organizationId: string,
    @Query('warehouseId') warehouseId: string | undefined,
    @Query('inventoryItemId') inventoryItemId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(user, organizationId, [
      OrganizationRole.ORG_ADMIN,
      OrganizationRole.OPERATIONS,
      OrganizationRole.WAREHOUSE,
      OrganizationRole.DISPATCHER,
    ]);

    return this.warehouseService.listInventoryMovements(
      organizationId,
      warehouseId,
      inventoryItemId,
    );
  }

  @Post('inventory-movements')
  @ApiOperation({ summary: 'Record an inventory movement and update stock' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiBody({ type: CreateInventoryMovementDto })
  @Roles(OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS, OrganizationRole.WAREHOUSE)
  async createInventoryMovement(
    @Param('organizationId') organizationId: string,
    @Body() body: CreateInventoryMovementDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationAccess(user, organizationId, [
      OrganizationRole.ORG_ADMIN,
      OrganizationRole.OPERATIONS,
      OrganizationRole.WAREHOUSE,
    ]);

    return this.warehouseService.createInventoryMovement(organizationId, body);
  }
}
