import { IsString, IsOptional, IsNumber, Min, Max } from 'class-validator';

export class TtsDto {
  @IsString()
  text!: string;

  @IsOptional()
  @IsString()
  language?: string; // z.B. 'de', 'en', 'es', ...

  @IsOptional()
  @IsString()
  voice?: string; // 'nova' | 'shimmer' | 'onyx' | 'echo' | direkte Polly-Voice

  @IsOptional()
  @IsString()
  format?: 'mp3' | 'ogg' | 'wav';

  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(1.5)
  speed?: number; // 0.5..1.5 (wird auf SSML prosody rate gemappt)

  @IsOptional()
  @IsString()
  engine?: 'neural' | 'standard';
}
