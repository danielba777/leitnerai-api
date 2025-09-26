import { Injectable, BadRequestException } from '@nestjs/common';
import { PollyClient, SynthesizeSpeechCommand, VoiceId } from '@aws-sdk/client-polly';
import { Readable } from 'stream';
import { spawn } from 'child_process';

import { TtsDialogDto } from './dto/tts-dialog.dto';

type PollyEngine = 'neural' | 'standard';

const REGION = process.env.AWS_REGION || 'eu-north-1';
const POLLY_REGION = process.env.POLLY_REGION || REGION;
const POLLY_ENGINE_DEFAULT = ((process.env.POLLY_ENGINE_DEFAULT || 'neural').toLowerCase() === 'standard'
  ? 'standard'
  : 'neural') as PollyEngine;

function xmlEscape(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function normalizeLang(lang?: string) {
  if (!lang) return 'en';
  const t = lang.trim().toLowerCase();
  // simple map
  if (['de', 'german', 'deutsch'].includes(t)) return 'de';
  if (['en', 'english', 'englisch'].includes(t)) return 'en';
  if (['es', 'spanish', 'spanisch'].includes(t)) return 'es';
  if (['fr', 'french', 'französisch'].includes(t)) return 'fr';
  if (['ja', 'japanese', 'japanisch'].includes(t)) return 'ja';
  if (['ko', 'korean', 'koreanisch'].includes(t)) return 'ko';
  if (['pt', 'pt-br', 'portuguese', 'portugiesisch'].includes(t)) return 'pt';
  if (['ru', 'russian', 'russisch'].includes(t)) return 'ru';
  return t;
}

/**
 * Mapping deiner Persona-Voices auf Polly VoiceIds je Sprache.
 * Fallback: sinnvolle neutrale Stimme.
 */
function mapVoice(personaOrPolly: string | undefined, lang: string): VoiceId {
  const l = normalizeLang(lang);
  const v = (personaOrPolly || '').toLowerCase();

  // Wenn bereits eine direkte Polly-Voice übergeben wurde (z.B. "Vicki"), nimm die.
  const knownPolly = new Map<string, VoiceId>([
    ['vicki', 'Vicki'],
    ['marlene', 'Marlene'],
    ['hans', 'Hans'],
    ['ivy', 'Ivy'],
    ['joanna', 'Joanna'],
    ['salli', 'Salli'],
    ['kimberly', 'Kimberly'],
    ['kendra', 'Kendra'],
    ['joey', 'Joey'],
    ['justin', 'Justin'],
    ['matthew', 'Matthew'],
    ['brian', 'Brian'],
    ['emma', 'Emma'],
    ['lucia', 'Lucia'],
    ['conchita', 'Conchita'],
    ['enrique', 'Enrique'],
    ['mia', 'Mia'],
    ['lea', 'Lea'],
    ['celine', 'Celine'],
    ['mathieu', 'Mathieu'],
    ['mizuki', 'Mizuki'],
    ['takumi', 'Takumi'],
    ['seoyeon', 'Seoyeon'],
    ['vitoria', 'Vitoria'],
    ['camila', 'Camila'],
    ['ricardo', 'Ricardo'],
    ['tatyana', 'Tatyana'],
    ['maxim', 'Maxim'],
  ]);
  const direct = knownPolly.get(v);
  if (direct) return direct;

  // Persona → Sprachspezifisches Polly-Äquivalent
  const tables: Record<string, Record<string, string>> = {
    // hell/freundlich (Kind/Jugendlich)
    nova: {
      de: 'Vicki', en: 'Ivy', es: 'Lucia', fr: 'Lea', ja: 'Mizuki', ko: 'Seoyeon', pt: 'Vitoria', ru: 'Tatyana',
    },
    // klar/hell
    shimmer: {
      de: 'Vicki', en: 'Joanna', es: 'Lucia', fr: 'Lea', ja: 'Mizuki', ko: 'Seoyeon', pt: 'Camila', ru: 'Tatyana',
    },
    // neutral/männlich (Teen/Jugendlich)
    onyx: {
      de: 'Hans', en: 'Matthew', es: 'Enrique', fr: 'Mathieu', ja: 'Takumi', ko: 'Seoyeon', pt: 'Ricardo', ru: 'Maxim',
    },
    // ruhig/ausgewogen (erwachsen männlich)
    echo: {
      de: 'Hans', en: 'Brian', es: 'Enrique', fr: 'Mathieu', ja: 'Takumi', ko: 'Seoyeon', pt: 'Ricardo', ru: 'Maxim',
    },
  };

  if (tables[v]?.[l]) return tables[v][l] as VoiceId;

  // generischer Fallback nach Sprache
  const fallback: Record<string, VoiceId> = {
    de: 'Vicki',
    en: 'Matthew',
    es: 'Lucia',
    fr: 'Lea',
    ja: 'Takumi',
    ko: 'Seoyeon',
    pt: 'Vitoria',
    ru: 'Tatyana',
  };
  return fallback[l] || 'Matthew';
}

function isEngineNotSupportedError(e: any): boolean {
  const name = String(e?.name || e?.Code || '').toLowerCase();
  const msg = String(e?.message || e).toLowerCase();
  return (
    name === 'validationexception' ||
    /engine/.test(msg) ||
    /neural/.test(msg) ||
    /not supported/.test(msg) ||
    /region/.test(msg)
  );
}

function toPollyFormat(fmt?: string) {
  const f = (fmt || 'mp3').toLowerCase();
  if (f === 'mp3') return { output: 'mp3' as const, mime: 'audio/mpeg', ext: 'mp3' };
  if (f === 'ogg') return { output: 'ogg_vorbis' as const, mime: 'audio/ogg', ext: 'ogg' };
  // PCM ist KEIN WAV – als audio/pcm und .pcm deklarieren
  if (f === 'wav') return { output: 'pcm' as const, mime: 'audio/pcm', ext: 'pcm' };
  return { output: 'mp3' as const, mime: 'audio/mpeg', ext: 'mp3' };
}

@Injectable()
export class TtsService {
  private polly = new PollyClient({ region: POLLY_REGION });

  private buildSSML(text: string, speed?: number) {
    const s = clamp(typeof speed === 'number' ? speed : 1.0, 0.5, 1.5);
    const ratePct = Math.round(s * 100);
    return `<speak><prosody rate="${ratePct}%">${xmlEscape(text.trim())}</prosody></speak>`;
  }

  /**
   * Liefert AudioStream + Metadaten für Streaming-Response
   */
  async synthesizeStream(opts: { text: string; language?: string; voice?: string; format?: string; speed?: number; engine?: PollyEngine }) {
    const { text, language, voice, format, speed } = opts;
    const requestedEngineInput = opts.engine ?? POLLY_ENGINE_DEFAULT;
    const requestedEngine: PollyEngine = requestedEngineInput === 'standard' ? 'standard' : 'neural';
    if (!text || !text.trim()) throw new BadRequestException('Text required');

    const lang = normalizeLang(language);
    const voiceId = mapVoice(voice, lang);
    const { output, mime, ext } = toPollyFormat(format);

    const cmdBase = {
      VoiceId: voiceId,
      OutputFormat: output,
      TextType: 'ssml' as const,
      Text: this.buildSSML(text, speed),
    };

    let res;
    try {
      res = await this.polly.send(
        new SynthesizeSpeechCommand({ Engine: requestedEngine, ...cmdBase }),
      );
    } catch (e: any) {
      if (requestedEngine === 'neural' && isEngineNotSupportedError(e)) {
        console.warn(
          `Polly neural engine not supported for voice ${voiceId} in ${POLLY_REGION}, falling back to standard.`,
        );
        try {
          res = await this.polly.send(
            new SynthesizeSpeechCommand({ Engine: 'standard', ...cmdBase }),
          );
        } catch (e2: any) {
          throw new BadRequestException(`Polly standard fallback failed: ${e2?.message || e2}`);
        }
      } else {
        throw new BadRequestException(`Polly synthesize failed: ${e?.message || e}`);
      }
    }

    if (!res.AudioStream) throw new BadRequestException('No audio stream from Polly');

    return {
      audioStream: res.AudioStream as Readable,
      contentType: res.ContentType || mime,
      ext,
      mime,
    };
  }

  /**
   * Liefert Base64-JSON wie deine bisherige Supabase-Funktion.
   */
  async synthesizeBase64(opts: { text: string; language?: string; voice?: string; format?: string; speed?: number; engine?: PollyEngine }) {
    const t0 = Date.now();
    const r = await this.synthesizeStream(opts);
    const chunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      r.audioStream
        .on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
        .on('end', () => resolve())
        .on('error', (e) => reject(e));
    });

    const buf = Buffer.concat(chunks);
    const b64 = buf.toString('base64');
    const dataUrl = `data:${r.mime};base64,${b64}`;

    return {
      audio: dataUrl,
      words: [],
      input_character_length: opts.text.length,
      output_format: r.ext,
      mime: r.mime,
      request_id: cryptoRandomId(),
      inference_status: {
        status: 'succeeded',
        runtime_ms: Date.now() - t0,
        cost: null,
      },
    };
  }

  private async synthesizeOneToBuffer(opts: {
    text: string;
    language?: string;
    voice?: string;
    format?: string;
    speed?: number;
    engine?: PollyEngine;
  }) {
    const r = await this.synthesizeStream(opts);
    const chunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      r.audioStream
        .on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
        .on('end', () => resolve())
        .on('error', (e) => reject(e));
    });

    return { buffer: Buffer.concat(chunks), mime: r.mime, ext: r.ext };
  }

  private async mergeWithFfmpeg(buffers: Buffer[], outFmt: 'mp3' | 'ogg' | 'wav', gapMs: number): Promise<Buffer> {
    const ffmpegPath = require('ffmpeg-static');
    if (!ffmpegPath) {
      throw new BadRequestException('ffmpeg-static binary not found');
    }
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ttsdlg-'));

    try {
      const inFiles: string[] = [];
      for (let i = 0; i < buffers.length; i++) {
        const f = path.join(tmpDir, `part_${i}.bin`);
        await fs.writeFile(f, buffers[i]);
        inFiles.push(f);
      }

      const listPath = path.join(tmpDir, 'list.txt');
      const silencePath = path.join(tmpDir, 'silence.mp3');

      if (gapMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const args = [
            '-f',
            'lavfi',
            '-t',
            String(gapMs / 1000),
            '-i',
            'anullsrc=r=22050:cl=mono',
            '-c:a',
            'libmp3lame',
            '-b:a',
            '128k',
            silencePath,
            '-y',
          ];
          const p = spawn(ffmpegPath, args);
          p.on('error', reject);
          p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg silence failed ${code}`))));
        });
      }

      const lines: string[] = [];
      for (let i = 0; i < inFiles.length; i++) {
        lines.push(`file '${inFiles[i]}'`);
        if (gapMs > 0 && i < inFiles.length - 1) {
          lines.push(`file '${silencePath}'`);
        }
      }
      await fs.writeFile(listPath, lines.join('\n'));

      const outPath = path.join(tmpDir, `out.${outFmt}`);
      const codecArgs =
        outFmt === 'ogg'
          ? ['-c:a', 'libvorbis']
          : outFmt === 'wav'
          ? ['-c:a', 'pcm_s16le']
          : ['-c:a', 'libmp3lame', '-b:a', '128k'];

      await new Promise<void>((resolve, reject) => {
        const args = ['-f', 'concat', '-safe', '0', '-i', listPath, ...codecArgs, outPath, '-y'];
        const p = spawn(ffmpegPath, args);
        p.on('error', reject);
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg concat failed ${code}`))));
      });

      return await fs.readFile(outPath);
    } finally {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }

  async synthesizeDialog(body: TtsDialogDto) {
    const t0 = Date.now();

    const outFormat = (body.format || 'mp3') as 'mp3' | 'ogg' | 'wav';
    const engineInput = body.engine ?? POLLY_ENGINE_DEFAULT;
    const engine: PollyEngine = engineInput === 'standard' ? 'standard' : 'neural';
    const gapMs = typeof body.gapMs === 'number' ? Math.max(0, Math.min(2000, body.gapMs)) : 150;
    const merge = body.merge !== false;

    const partsFormat: 'mp3' | 'ogg' | 'wav' = merge ? 'mp3' : outFormat;

    const parts: { buffer: Buffer; mime: string; ext: string }[] = [];
    for (const turn of body.turns) {
      const one = await this.synthesizeOneToBuffer({
        text: turn.text,
        language: turn.language,
        voice: turn.voice,
        format: partsFormat,
        speed: turn.speed,
        engine,
      });
      parts.push(one);
    }

    if (!merge) {
      const segments = parts.map((p) => `data:${p.mime};base64,${p.buffer.toString('base64')}`);
      return {
        merged: false,
        segments,
        mime: parts[0]?.mime || 'audio/mpeg',
        ext: parts[0]?.ext || 'mp3',
        inference_status: {
          status: 'succeeded',
          runtime_ms: Date.now() - t0,
          cost: null,
        },
      };
    }

    const merged = await this.mergeWithFfmpeg(
      parts.map((p) => p.buffer),
      outFormat,
      gapMs,
    );
    const mime = outFormat === 'ogg' ? 'audio/ogg' : outFormat === 'wav' ? 'audio/wav' : 'audio/mpeg';
    const ext = outFormat === 'ogg' ? 'ogg' : outFormat === 'wav' ? 'wav' : 'mp3';

    return {
      merged: true,
      audio: `data:${mime};base64,${merged.toString('base64')}`,
      mime,
      ext,
      inference_status: {
        status: 'succeeded',
        runtime_ms: Date.now() - t0,
        cost: null,
      },
    };
  }
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
