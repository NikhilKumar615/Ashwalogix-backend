import {
  BadRequestException,
  Body,
  ForbiddenException,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { DocumentEntityType, OrganizationRole } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AuthorizationService } from '../auth/authorization.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { SectionAccess } from '../auth/decorators/section-access.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CreateDocumentDto } from './dto/create-document.dto';
import { GenerateUploadUrlDto } from './dto/generate-upload-url.dto';
import { DocumentsService } from './documents.service';

@ApiTags('Documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@SectionAccess('documents')
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly authorizationService: AuthorizationService,
  ) {}

  @Post('upload-url')
  @ApiOperation({
    summary: 'Generate a signed Cloudinary upload target for a document',
  })
  @ApiBody({ type: GenerateUploadUrlDto })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
    OrganizationRole.DRIVER,
  )
  async generateUploadUrl(
    @Body() body: GenerateUploadUrlDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(
      user,
      body.organizationId,
    );

    if (user.membershipRoles.includes(OrganizationRole.DRIVER)) {
      if (!body.shipmentId) {
        throw new BadRequestException(
          'shipmentId is required for driver document uploads',
        );
      }

      await this.authorizationService.assertShipmentAccess(
        user,
        body.shipmentId,
        {
          allowAssignedDriver: true,
        },
      );
    }

    return this.documentsService.generateUploadUrl(body);
  }

  @Post()
  @ApiOperation({ summary: 'Create a document metadata record after upload' })
  @ApiBody({ type: CreateDocumentDto })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
    OrganizationRole.DRIVER,
  )
  async createDocument(
    @Body() body: CreateDocumentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.authorizationService.assertOrganizationWriteAccess(
      user,
      body.organizationId,
    );

    if (user.membershipRoles.includes(OrganizationRole.DRIVER)) {
      if (!body.shipmentId) {
        throw new BadRequestException(
          'shipmentId is required for driver document metadata creation',
        );
      }

      await this.authorizationService.assertShipmentAccess(
        user,
        body.shipmentId,
        {
          allowAssignedDriver: true,
        },
      );

      if (
        this.isDriverOnlyInOrganization(user, body.organizationId) &&
        body.entityType !== DocumentEntityType.SHIPMENT &&
        body.entityType !== DocumentEntityType.POD
      ) {
        throw new ForbiddenException(
          'Drivers can only attach shipment or proof-of-delivery documents',
        );
      }
    }

    return this.documentsService.createDocument(body, user.sub);
  }

  @Get('shipment/:shipmentId')
  @ApiOperation({ summary: 'List documents attached to a shipment' })
  @ApiParam({ name: 'shipmentId', type: String })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
    OrganizationRole.DRIVER,
  )
  async getShipmentDocuments(
    @Param('shipmentId') shipmentId: string,
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

    return this.documentsService.getShipmentDocuments(shipmentId);
  }

  @Get(':documentId/access-url')
  @ApiOperation({ summary: 'Generate a signed access URL for a document' })
  @ApiParam({ name: 'documentId', type: String })
  @Roles(
    OrganizationRole.ORG_ADMIN,
    OrganizationRole.DISPATCHER,
    OrganizationRole.OPERATIONS,
    OrganizationRole.WAREHOUSE,
    OrganizationRole.DRIVER,
  )
  async getDocumentAccessUrl(
    @Param('documentId') documentId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const document = await this.documentsService.getDocumentById(documentId);

    if (!document) {
      throw new BadRequestException('Document not found');
    }

    await this.authorizationService.assertOrganizationAccess(
      user,
      document.organizationId,
    );

    if (!document.shipmentId) {
      // M2: organization-level documents (KYC, driver, client, vehicle docs)
      // are not visible to every member of the organization.
      await this.assertOrganizationLevelDocumentAccess(user, document);
    } else {
      await this.authorizationService.assertShipmentAccess(
        user,
        document.shipmentId,
        {
          allowedOrganizationRoles: [
            OrganizationRole.ORG_ADMIN,
            OrganizationRole.DISPATCHER,
            OrganizationRole.OPERATIONS,
            OrganizationRole.WAREHOUSE,
          ],
          allowAssignedDriver: true,
        },
      );
    }

    return this.documentsService.generateAccessUrl(documentId);
  }

  private async assertOrganizationLevelDocumentAccess(
    user: JwtPayload,
    document: {
      organizationId: string;
      entityType: DocumentEntityType;
      entityId: string;
    },
  ) {
    if (document.entityType === DocumentEntityType.DRIVER) {
      // Staff who manage drivers, or the driver the document belongs to.
      await this.authorizationService.assertDriverAccess(
        user,
        document.entityId,
        document.organizationId,
        [
          OrganizationRole.ORG_ADMIN,
          OrganizationRole.OPERATIONS,
          OrganizationRole.DISPATCHER,
        ],
      );
      return;
    }

    if (document.entityType === DocumentEntityType.ORGANIZATION) {
      // KYC / company documents.
      await this.authorizationService.assertOrganizationAccess(
        user,
        document.organizationId,
        [OrganizationRole.ORG_ADMIN, OrganizationRole.OPERATIONS],
      );
      return;
    }

    // CLIENT / VEHICLE / other entity documents: back-office staff only.
    await this.authorizationService.assertOrganizationAccess(
      user,
      document.organizationId,
      [
        OrganizationRole.ORG_ADMIN,
        OrganizationRole.OPERATIONS,
        OrganizationRole.DISPATCHER,
        OrganizationRole.WAREHOUSE,
      ],
    );
  }

  private isDriverOnlyInOrganization(user: JwtPayload, organizationId: string) {
    const roles = user.memberships
      .filter((membership) => membership.organizationId === organizationId)
      .map((membership) => membership.role);
    return (
      roles.length > 0 &&
      roles.every((role) => role === (OrganizationRole.DRIVER as string))
    );
  }
}
