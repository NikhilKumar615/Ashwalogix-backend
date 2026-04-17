import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DocumentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { GenerateUploadUrlDto } from './dto/generate-upload-url.dto';
import { GeneratePublicUploadUrlDto } from './dto/generate-public-upload-url.dto';

@Injectable()
export class DocumentsService {
  private readonly bucketName: string;
  private readonly region: string;
  private readonly s3Client: S3Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.bucketName = this.configService.get<string>('AWS_S3_BUCKET') ?? '';
    this.region = this.configService.get<string>('AWS_REGION') ?? 'us-east-1';

    const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get<string>(
      'AWS_SECRET_ACCESS_KEY',
    );

    this.s3Client = new S3Client({
      region: this.region,
      credentials:
        accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey }
          : undefined,
    });
  }

  async generateUploadUrl(input: GenerateUploadUrlDto) {
    this.ensureBucketConfigured();

    const storageKey = this.buildStorageKey(input);
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: storageKey,
      ContentType: input.mimeType ?? 'application/octet-stream',
    });

    try {
      const uploadUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn: 900,
      });

      return {
        bucket: this.bucketName,
        region: this.region,
        key: storageKey,
        uploadUrl,
      };
    } catch (error) {
      throw new InternalServerErrorException(
        `Failed to generate upload URL: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  async generatePublicUploadUrl(input: GeneratePublicUploadUrlDto) {
    this.ensureBucketConfigured();

    const storageKey = this.buildPublicRegistrationStorageKey(input);
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: storageKey,
      ContentType: input.mimeType ?? 'application/octet-stream',
    });

    try {
      const uploadUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn: 900,
      });

      return {
        bucket: this.bucketName,
        region: this.region,
        key: storageKey,
        uploadUrl,
      };
    } catch (error) {
      throw new InternalServerErrorException(
        `Failed to generate upload URL: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  async uploadPublicRegistrationDocument(input: {
    documentType: string;
    fileName: string;
    mimeType?: string;
    fileBuffer: Buffer;
    fileSize?: number;
  }) {
    this.ensureBucketConfigured();

    const storageKey = this.buildPublicRegistrationStorageKey({
      documentType: input.documentType,
      fileName: input.fileName,
      mimeType: input.mimeType,
    });

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: storageKey,
      Body: input.fileBuffer,
      ContentType: input.mimeType ?? 'application/octet-stream',
    });

    try {
      await this.s3Client.send(command);

      return {
        bucket: this.bucketName,
        region: this.region,
        key: storageKey,
        fileName: input.fileName,
        mimeType: input.mimeType ?? 'application/octet-stream',
        fileSize: input.fileSize ?? input.fileBuffer.length,
      };
    } catch (error) {
      throw new InternalServerErrorException(
        `Failed to upload file: ${error instanceof Error ? error.message : 'unknown error'}`,
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
    return this.prisma.document.findUnique({
      where: { id: documentId },
    });
  }

  async generateAccessUrl(documentId: string) {
    this.ensureBucketConfigured();

    const document = await this.getDocumentById(documentId);

    if (!document) {
      throw new BadRequestException('Document not found');
    }

    const command = new GetObjectCommand({
      Bucket: document.storageBucket || this.bucketName,
      Key: document.storageKey,
      ResponseContentDisposition: 'inline',
      ResponseContentType: document.mimeType ?? 'application/octet-stream',
    });

    try {
      const url = await getSignedUrl(this.s3Client, command, {
        expiresIn: 900,
      });

      return {
        documentId: document.id,
        fileName: document.fileName,
        mimeType: document.mimeType,
        url,
      };
    } catch (error) {
      throw new InternalServerErrorException(
        `Failed to generate access URL: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
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

  private ensureBucketConfigured() {
    if (!this.bucketName) {
      throw new BadRequestException(
        'AWS_S3_BUCKET is not configured in the environment',
      );
    }
  }
}
