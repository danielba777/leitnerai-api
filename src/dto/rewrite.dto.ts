import { IsString, IsOptional, IsNumber, Min, Max } from 'class-validator';

export class RewriteDto {
  @IsString()
  text!: string;

  /** Optional: override des Default-Modells */
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
