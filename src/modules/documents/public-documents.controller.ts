import { Body, Controller, Post } from '@nestjs/common';
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
}
