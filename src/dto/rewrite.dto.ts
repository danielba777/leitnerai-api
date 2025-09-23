import { IsString, IsOptional, IsNumber, Min, Max, IsIn } from 'class-validator';

export class RewriteDto {
  @IsString()
  text!: string;

  /** optional: 'deepseek' (Default) | 'bedrock' */
  @IsOptional()
  @IsIn(['deepseek', 'bedrock'])
  provider?: 'deepseek' | 'bedrock';

  /** z. B. 'deepseek-chat' oder Bedrock-Model-ID */
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
