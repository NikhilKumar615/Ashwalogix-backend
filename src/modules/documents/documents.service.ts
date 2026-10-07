import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { DocumentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { GenerateUploadUrlDto } from './dto/generate-upload-url.dto';
import { GeneratePublicUploadUrlDto } from './dto/generate-public-upload-url.dto';
import {
  AUTHENTICATED_UPLOAD_FORMATS,
  AUTHENTICATED_UPLOAD_MAX_BYTES,
  detectPublicUploadMimeType,
  hasPathTraversal,
  normalizeMimeType,
  organizationStoragePrefix,
  PUBLIC_REGISTRATION_STORAGE_PREFIX,
  PUBLIC_UPLOAD_FORMATS,
  PUBLIC_UPLOAD_MAX_BYTES,
  PUBLIC_UPLOAD_MIME_TYPES,
  resolveAllowedExtension,
  sanitizeFileName,
  sanitizeKeySegment,
} from './documents-upload-policy';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
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

  generateUploadUrl(input: GenerateUploadUrlDto) {
    if (
      typeof input.fileSize === 'number' &&
      input.fileSize > AUTHENTICATED_UPLOAD_MAX_BYTES
    ) {
      throw new PayloadTooLargeException(
        `Files larger than ${AUTHENTICATED_UPLOAD_MAX_BYTES / (1024 * 1024)} MB are not allowed`,
      );
    }

    const extension = this.requireAllowedExtension(
      input.fileName,
      input.mimeType,
      AUTHENTICATED_UPLOAD_FORMATS,
    );

    return this.createSignedUploadTarget(
      this.buildStorageKey(input, extension),
      AUTHENTICATED_UPLOAD_FORMATS,
    );
  }

  generatePublicUploadUrl(input: GeneratePublicUploadUrlDto) {
    const extension = this.requireAllowedExtension(
      input.fileName,
      input.mimeType,
      PUBLIC_UPLOAD_FORMATS,
    );

    return this.createSignedUploadTarget(
      this.buildPublicRegistrationStorageKey(input, extension),
      PUBLIC_UPLOAD_FORMATS,
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

    const size = input.fileBuffer?.length ?? 0;
    if (size === 0) {
      throw new BadRequestException('file is empty');
    }
    if (size > PUBLIC_UPLOAD_MAX_BYTES) {
      throw new PayloadTooLargeException(
        `Files larger than ${PUBLIC_UPLOAD_MAX_BYTES / (1024 * 1024)} MB are not allowed`,
      );
    }

    const declaredMime = normalizeMimeType(input.mimeType);
    if (!PUBLIC_UPLOAD_MIME_TYPES.has(declaredMime)) {
      throw new BadRequestException(
        'Only PDF, JPEG, PNG or WEBP files are allowed',
      );
    }

    // Never trust the declared type: verify the content's magic bytes.
    const detectedMime = detectPublicUploadMimeType(input.fileBuffer);
    if (!detectedMime || detectedMime !== declaredMime) {
      throw new BadRequestException(
        'The file content does not match an allowed PDF, JPEG, PNG or WEBP file',
      );
    }

    const extension = this.requireAllowedExtension(
      // Derive the extension from the verified content type, not the name.
      input.fileName.replace(/\.[A-Za-z0-9]{1,8}$/, ''),
      detectedMime,
      PUBLIC_UPLOAD_FORMATS,
    );
    const storageKey = this.buildPublicRegistrationStorageKey(
      {
        documentType: input.documentType,
        fileName: input.fileName,
        mimeType: detectedMime,
      },
      extension,
    );

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
                  error
                    ? new Error(this.describeError(error))
                    : new Error('Cloudinary did not return an upload result'),
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
        mimeType: detectedMime,
        fileSize: size,
      });
    } catch (error) {
      this.logger.error(
        `Cloudinary public upload failed: ${this.describeError(error)}`,
      );
      throw new InternalServerErrorException(
        'Failed to upload file. Please try again.',
      );
    }
  }

  /**
   * Creates a document record for a file uploaded through a server-issued
   * upload target. `uploadedBy` is always the authenticated user.
   */
  async createDocument(input: CreateDocumentDto, uploadedByUserId?: string) {
    this.assertServerIssuedStorage(input);

    if (
      typeof input.fileSize === 'number' &&
      input.fileSize > AUTHENTICATED_UPLOAD_MAX_BYTES
    ) {
      throw new PayloadTooLargeException(
        `Files larger than ${AUTHENTICATED_UPLOAD_MAX_BYTES / (1024 * 1024)} MB are not allowed`,
      );
    }

    return this.prisma.document.create({
      data: {
        organizationId: input.organizationId,
        shipmentId: input.shipmentId,
        entityType: input.entityType,
        entityId: input.entityId,
        documentType: input.documentType,
        fileName: input.fileName,
        storageBucket: this.cloudName || input.storageBucket,
        storageKey: input.storageKey,
        mimeType: input.mimeType,
        fileSize: input.fileSize,
        // New records are always UPLOADED; archive/delete are separate actions.
        status: DocumentStatus.UPLOADED,
        uploadedBy: uploadedByUserId ?? null,
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

    // Defence in depth for legacy rows: only sign keys inside the document's
    // own organization prefix (or the public registration prefix).
    if (
      hasPathTraversal(document.storageKey) ||
      !(
        document.storageKey.startsWith(
          organizationStoragePrefix(document.organizationId),
        ) || document.storageKey.startsWith(PUBLIC_REGISTRATION_STORAGE_PREFIX)
      )
    ) {
      this.logger.warn(
        `Refusing to sign document ${document.id}: storage key is outside the organization prefix`,
      );
      throw new BadRequestException('Document is not available');
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
      this.logger.error(
        `Failed to generate access URL for document ${document.id}: ${this.describeError(error)}`,
      );
      throw new InternalServerErrorException(
        'Failed to generate document access URL',
      );
    }
  }

  /**
   * S6: the storage key must be one this server issued for the same
   * organization and entity (see buildStorageKey); client-chosen keys pointing
   * at other tenants' files are rejected.
   */
  private assertServerIssuedStorage(input: CreateDocumentDto) {
    const key = input.storageKey ?? '';
    const expectedPrefix = [
      'organizations',
      input.organizationId,
      input.entityType.toLowerCase(),
      input.entityId,
      '',
    ].join('/');

    if (
      !key.startsWith(expectedPrefix) ||
      key.length <= expectedPrefix.length ||
      key.slice(expectedPrefix.length).includes('/') ||
      hasPathTraversal(key)
    ) {
      throw new BadRequestException(
        'storageKey must be the key returned by /documents/upload-url for this organization and entity',
      );
    }

    if (
      this.cloudName &&
      input.storageBucket &&
      input.storageBucket !== this.cloudName
    ) {
      throw new BadRequestException(
        'storageBucket must be the bucket returned by /documents/upload-url',
      );
    }
  }

  private requireAllowedExtension(
    fileName: string,
    mimeType: string | undefined,
    allowed: Readonly<Record<string, string>>,
  ) {
    const extension = resolveAllowedExtension(fileName, mimeType, allowed);
    if (!extension) {
      throw new BadRequestException(
        `File type is not allowed. Allowed types: ${Object.keys(allowed).join(', ')}`,
      );
    }
    return extension;
  }

  private createSignedUploadTarget(
    storageKey: string,
    allowedFormats: Readonly<Record<string, string>>,
  ) {
    this.ensureCloudinaryConfigured();
    const timestamp = Math.floor(Date.now() / 1000);
    // Signed params restrict what the browser/app may upload to this target.
    const allowed_formats = Object.keys(allowedFormats).join(',');
    const uploadFields = {
      api_key: this.apiKey,
      timestamp: String(timestamp),
      public_id: storageKey,
      type: 'authenticated',
      allowed_formats,
      signature: cloudinary.utils.api_sign_request(
        {
          allowed_formats,
          public_id: storageKey,
          timestamp,
          type: 'authenticated',
        },
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

  private buildStorageKey(input: GenerateUploadUrlDto, extension: string) {
    return [
      'organizations',
      input.organizationId,
      input.entityType.toLowerCase(),
      input.entityId,
      `${sanitizeKeySegment(input.documentType)}-${randomUUID()}-${sanitizeFileName(input.fileName, extension)}`,
    ].join('/');
  }

  private buildPublicRegistrationStorageKey(
    input: GeneratePublicUploadUrlDto,
    extension: string,
  ) {
    return [
      PUBLIC_REGISTRATION_STORAGE_PREFIX.replace(/\/$/, ''),
      sanitizeKeySegment(input.documentType).toLowerCase(),
      `${randomUUID()}-${sanitizeFileName(input.fileName, extension)}`,
    ].join('/');
  }

  private ensureCloudinaryConfigured() {
    if (!this.cloudName || !this.apiKey || !this.apiSecret) {
      this.logger.error(
        'CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET must be configured',
      );
      throw new BadRequestException('Document storage is not configured');
    }
  }

  private describeError(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }
    if (error && typeof error === 'object' && 'message' in error) {
      return String((error as { message: unknown }).message);
    }
    return 'unknown error';
  }
}
