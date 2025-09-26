import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TtsController } from './tts.controller';
import { TtsService } from './tts.service';

@Module({
  imports: [],
  controllers: [AppController, TtsController],
  providers: [AppService, TtsService],
})
export class AppModule {}
