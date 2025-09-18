import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  BadRequestException,
} from '@nestjs/common';
import { AppService } from './app.service';
import { UploadUrlDto } from './dto/upload-url.dto';
import { ExtractDto } from './dto/extract.dto';

@Controller()
export class AppController {
  constructor(private readonly app: AppService) {}

  @Get()
  getHello(): string {
    return this.app.getHello();
  }

  @Get('/host')
  getHost(): string {
    return this.app.getPrivateIpOrHostname();
  }

  @Get('/health')
  health() {
    return this.app.health();
  }

  @Post('/upload-url')
  createUploadUrl(@Body() body: UploadUrlDto) {
    if (!body?.filename) throw new BadRequestException('filename required');
    return this.app.createUploadUrl(body.filename);
  }

  @Post('/extract')
  extract(@Body() body: ExtractDto) {
    if (!body?.jobId || !body?.s3Key)
      throw new BadRequestException('jobId & s3Key required');
    return this.app.enqueueJob(body.jobId, body.s3Key, body.ocr, body.language);
  }

  @Get('/status/:id')
  status(@Param('id') id: string) {
    return this.app.getStatus(id);
  }

  @Get('/download/:id')
  download(@Param('id') id: string) {
    return this.app.getResultDownloadUrl(id);
  }
}
