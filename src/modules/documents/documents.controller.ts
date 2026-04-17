import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
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
import { AuthorizationService } from '../auth/authorization.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { CreateDocumentDto } from './dto/create-document.dto';
import { GenerateUploadUrlDto } from './dto/generate-upload-url.dto';
import { DocumentsService } from './documents.service';

@ApiTags('Documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly authorizationService: AuthorizationService,
  ) {}

  @Post('upload-url')
  @ApiOperation({ summary: 'Generate a presigned S3 upload URL for a document' })
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

      await this.authorizationService.assertShipmentAccess(user, body.shipmentId, {
        allowAssignedDriver: true,
      });
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

      await this.authorizationService.assertShipmentAccess(user, body.shipmentId, {
        allowAssignedDriver: true,
      });
    }

    return this.documentsService.createDocument(body);
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

    if (document.shipmentId) {
      await this.authorizationService.assertShipmentAccess(user, document.shipmentId, {
        allowedOrganizationRoles: [
          OrganizationRole.ORG_ADMIN,
          OrganizationRole.DISPATCHER,
          OrganizationRole.OPERATIONS,
          OrganizationRole.WAREHOUSE,
        ],
        allowAssignedDriver: true,
      });
    }

    return this.documentsService.generateAccessUrl(documentId);
  }
}
