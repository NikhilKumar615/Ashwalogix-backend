import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AUTH_THROTTLE } from '../../shared/config/http-throttler.guard';
import { DocumentsService } from './documents.service';
import {
  normalizeMimeType,
  PUBLIC_UPLOAD_MAX_BYTES,
  PUBLIC_UPLOAD_MIME_TYPES,
} from './documents-upload-policy';
import { GeneratePublicUploadUrlDto } from './dto/generate-public-upload-url.dto';

@ApiTags('Documents')
// S8: unauthenticated upload routes get a strict per-IP rate limit.
@Throttle(AUTH_THROTTLE.publicUpload)
@Controller('documents')
export class PublicDocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('public-upload-url')
  @ApiOperation({
    summary:
      'Generate a signed Cloudinary upload target for public onboarding documents before registration',
  })
  @ApiBody({ type: GeneratePublicUploadUrlDto })
  generatePublicUploadUrl(@Body() body: GeneratePublicUploadUrlDto) {
    return this.documentsService.generatePublicUploadUrl(body);
  }

  @Post('public-upload')
  @UseInterceptors(
    FileInterceptor('file', {
      // S11: bounded, single-file, allowlisted uploads only.
      limits: { fileSize: PUBLIC_UPLOAD_MAX_BYTES, files: 1, fields: 10 },
      fileFilter: (_req, file, callback) => {
        if (!PUBLIC_UPLOAD_MIME_TYPES.has(normalizeMimeType(file.mimetype))) {
          callback(
            new BadRequestException(
              'Only PDF, JPEG, PNG or WEBP files are allowed',
            ),
            false,
          );
          return;
        }
        callback(null, true);
      },
    }),
  )
  @ApiOperation({
    summary:
      'Upload a public onboarding document through the backend to avoid browser-side Cloudinary CORS issues',
  })
  async uploadPublicDocument(
    @UploadedFile()
    file:
      | {
          originalname: string;
          mimetype: string;
          buffer: Buffer;
          size: number;
        }
      | undefined,
    @Body('documentType') documentType: string | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('file is required');
    }

    if (!documentType) {
      throw new BadRequestException('documentType is required');
    }

    return this.documentsService.uploadPublicRegistrationDocument({
      documentType,
      fileName: file.originalname,
      mimeType: file.mimetype,
      fileBuffer: file.buffer,
      fileSize: file.size,
    });
  }
}
