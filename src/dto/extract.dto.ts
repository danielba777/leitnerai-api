import { IsString, IsOptional, IsBoolean } from 'class-validator';

export class ExtractDto {
  @IsString()
  jobId!: string;

  @IsString()
  s3Key!: string; // muss mit "uploads/" beginnen

  @IsOptional()
  @IsBoolean()
  ocr?: boolean; // optional: OCR-Wunsch
}
