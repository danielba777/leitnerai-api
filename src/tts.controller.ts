import { BadRequestException, Controller, Get, Post, Query, Body, Res } from '@nestjs/common';
import { Response } from 'express';
import { TtsService } from './tts.service';
import { TtsDto } from './dto/tts.dto';

@Controller()
export class TtsController {
  constructor(private readonly tts: TtsService) {}

  @Get('/tts')
  async ttsStream(
    @Res() res: Response,
    @Query('text') text: string,
    @Query('language') language?: string,
    @Query('voice') voice?: string,
    @Query('format') format?: string,
    @Query('speed') speedStr?: string,
  ) {
    if (!text || !text.trim()) throw new BadRequestException('text required');
    const speed = speedStr ? Number(speedStr) : undefined;

    const r = await this.tts.synthesizeStream({ text, language, voice, format, speed });

    res.setHeader('Content-Type', r.contentType || 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');

    res.on('close', () => {
      try {
        (r.audioStream as any)?.destroy?.();
      } catch {}
    });

    r.audioStream.on('error', () => {
      try {
        if (!res.headersSent) res.status(500);
        res.end();
      } catch {}
    });

    r.audioStream.pipe(res);
  }

  @Post('/tts')
  async ttsJson(@Body() body: TtsDto) {
    if (!body?.text || !body.text.trim()) throw new BadRequestException('text required');
    return this.tts.synthesizeBase64({
      text: body.text,
      language: body.language,
      voice: body.voice,
      format: body.format,
      speed: body.speed,
    });
  }
}
