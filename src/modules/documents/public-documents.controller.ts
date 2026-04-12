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
import { DocumentsService } from './documents.service';
import { GeneratePublicUploadUrlDto } from './dto/generate-public-upload-url.dto';

@ApiTags('Documents')
@Controller('documents')
export class PublicDocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('public-upload-url')
  @ApiOperation({
    summary:
      'Generate a presigned upload URL for public onboarding documents before registration',
  })
  @ApiBody({ type: GeneratePublicUploadUrlDto })
  async generatePublicUploadUrl(@Body() body: GeneratePublicUploadUrlDto) {
    return this.documentsService.generatePublicUploadUrl(body);
  }

  @Post('public-upload')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary:
      'Upload a public onboarding document through the backend to avoid browser-side storage CORS issues',
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
