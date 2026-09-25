import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { DocumentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { GenerateUploadUrlDto } from './dto/generate-upload-url.dto';
import { GeneratePublicUploadUrlDto } from './dto/generate-public-upload-url.dto';

@Injectable()
export class DocumentsService {
  private readonly cloudName: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.cloudName =
      this.configService.get<string>('CLOUDINARY_CLOUD_NAME') ?? '';
    this.apiKey = this.configService.get<string>('CLOUDINARY_API_KEY') ?? '';
    this.apiSecret =
      this.configService.get<string>('CLOUDINARY_API_SECRET') ?? '';

    if (this.cloudName && this.apiKey && this.apiSecret) {
      cloudinary.config({
        cloud_name: this.cloudName,
        api_key: this.apiKey,
        api_secret: this.apiSecret,
        secure: true,
      });
    }
  }

  async generateUploadUrl(input: GenerateUploadUrlDto) {
    return this.createSignedUploadTarget(this.buildStorageKey(input));
  }

  async generatePublicUploadUrl(input: GeneratePublicUploadUrlDto) {
    return this.createSignedUploadTarget(
      this.buildPublicRegistrationStorageKey(input),
    );
  }

  async uploadPublicRegistrationDocument(input: {
    documentType: string;
    fileName: string;
    mimeType?: string;
    fileBuffer: Buffer;
    fileSize?: number;
  }) {
    this.ensureCloudinaryConfigured();
    const storageKey = this.buildPublicRegistrationStorageKey({
      documentType: input.documentType,
      fileName: input.fileName,
      mimeType: input.mimeType,
    });

    try {
      const result = await new Promise<{ public_id: string }>(
        (resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              resource_type: 'raw',
              type: 'authenticated',
              public_id: storageKey,
              overwrite: false,
            },
            (error, uploadResult) => {
              if (error || !uploadResult) {
                reject(
                  error ??
                    new Error('Cloudinary did not return an upload result'),
                );
                return;
              }
              resolve({ public_id: uploadResult.public_id });
            },
          );
          stream.end(input.fileBuffer);
        },
      );

      return this.storageMetadata({
        key: result.public_id,
        fileName: input.fileName,
        mimeType: input.mimeType,
        fileSize: input.fileSize ?? input.fileBuffer.length,
      });
    } catch (error) {
      throw new InternalServerErrorException(
        `Failed to upload file to Cloudinary: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  async createDocument(input: CreateDocumentDto) {
    return this.prisma.document.create({
      data: {
        organizationId: input.organizationId,
        shipmentId: input.shipmentId,
        entityType: input.entityType,
        entityId: input.entityId,
        documentType: input.documentType,
        fileName: input.fileName,
        storageBucket: input.storageBucket,
        storageKey: input.storageKey,
        mimeType: input.mimeType,
        fileSize: input.fileSize,
        status: input.status ?? DocumentStatus.UPLOADED,
        uploadedBy: input.uploadedBy,
      },
    });
  }

  async getShipmentDocuments(shipmentId: string) {
    return this.prisma.document.findMany({
      where: { shipmentId },
      orderBy: { uploadedAt: 'desc' },
    });
  }

  async getDocumentById(documentId: string) {
    return this.prisma.document.findUnique({ where: { id: documentId } });
  }

  async generateAccessUrl(documentId: string) {
    this.ensureCloudinaryConfigured();
    const document = await this.getDocumentById(documentId);
    if (!document) {
      throw new BadRequestException('Document not found');
    }

    try {
      const url = cloudinary.utils.private_download_url(
        document.storageKey,
        '',
        {
          resource_type: 'raw',
          type: 'authenticated',
          expires_at: Math.floor(Date.now() / 1000) + 900,
          attachment: false,
        },
      );
      return {
        documentId: document.id,
        fileName: document.fileName,
        mimeType: document.mimeType,
        url,
      };
    } catch (error) {
      throw new InternalServerErrorException(
        `Failed to generate document access URL: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private createSignedUploadTarget(storageKey: string) {
    this.ensureCloudinaryConfigured();
    const timestamp = Math.floor(Date.now() / 1000);
    const uploadFields = {
      api_key: this.apiKey,
      timestamp: String(timestamp),
      public_id: storageKey,
      type: 'authenticated',
      signature: cloudinary.utils.api_sign_request(
        { public_id: storageKey, timestamp, type: 'authenticated' },
        this.apiSecret,
      ),
    };

    return {
      ...this.storageMetadata({ key: storageKey }),
      uploadUrl: `https://api.cloudinary.com/v1_1/${this.cloudName}/raw/upload`,
      uploadMethod: 'POST' as const,
      uploadFields,
    };
  }

  private storageMetadata(input: {
    key: string;
    fileName?: string;
    mimeType?: string;
    fileSize?: number;
  }) {
    return {
      bucket: this.cloudName,
      storageBucket: this.cloudName,
      key: input.key,
      storageKey: input.key,
      fileName: input.fileName,
      mimeType: input.mimeType ?? 'application/octet-stream',
      fileSize: input.fileSize,
    };
  }

  private buildStorageKey(input: GenerateUploadUrlDto) {
    const safeFileName = input.fileName.replace(/\s+/g, '-');
    return [
      'organizations',
      input.organizationId,
      input.entityType.toLowerCase(),
      input.entityId,
      `${input.documentType}-${randomUUID()}-${safeFileName}`,
    ].join('/');
  }

  private buildPublicRegistrationStorageKey(input: GeneratePublicUploadUrlDto) {
    const safeFileName = input.fileName.replace(/\s+/g, '-');
    return [
      'public',
      'registrations',
      'company-admin',
      input.documentType.toLowerCase(),
      `${randomUUID()}-${safeFileName}`,
    ].join('/');
  }

  private ensureCloudinaryConfigured() {
    if (!this.cloudName || !this.apiKey || !this.apiSecret) {
      throw new BadRequestException(
        'CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET must be configured',
      );
    }
  }
}
