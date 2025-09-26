import { Type } from 'class-transformer';
import {
  IsArray,
  ArrayMinSize,
  IsOptional,
  IsString,
  IsNumber,
  Min,
  Max,
  ValidateNested,
  IsBoolean,
} from 'class-validator';

class DialogTurnDto {
  @IsString()
  text!: string;

  @IsOptional()
  @IsString()
  speaker?: string; // z.B. "Tom", "Lucy" – rein informativ

  @IsOptional()
  @IsString()
  voice?: string; // "nova" | "shimmer" | "onyx" | "echo" | direkte Polly-Voice ("Vicki" etc.)

  @IsOptional()
  @IsString()
  language?: string; // 'en' | 'de' | ...

  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(1.5)
  speed?: number; // 0.5..1.5
}

export class TtsDialogDto {
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => DialogTurnDto)
  turns!: DialogTurnDto[];

  @IsOptional()
  @IsString()
  format?: 'mp3' | 'ogg' | 'wav';

  @IsOptional()
  @IsString()
  engine?: 'neural' | 'standard'; // optional: Engine überschreiben

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2000)
  gapMs?: number; // Stille zwischen Turns (in ms), Default 150

  @IsOptional()
  @IsBoolean()
  merge?: boolean; // true = eine Datei (Default), false = Segmente
}
