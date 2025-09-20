import { IsString, IsOptional, IsNumber, Min, Max, IsIn } from 'class-validator';

export class RewriteDto {
  @IsString()
  text!: string;

  /** 'de', 'en', ... – default: 'unknown' -> System erkennt Sprache */
  @IsOptional()
  @IsString()
  language?: string;

  /** optional: 'deepseek' (Default) | 'bedrock' (später) */
  @IsOptional()
  @IsIn(['deepseek', 'bedrock'])
  provider?: 'deepseek' | 'bedrock';

  /** z. B. 'deepseek-chat' */
  @IsOptional()
  @IsString()
  model?: string;

  /** 0..2 */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;
}
