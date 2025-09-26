import { Injectable, BadRequestException } from '@nestjs/common';
import { PollyClient, SynthesizeSpeechCommand, VoiceId } from '@aws-sdk/client-polly';
import { Readable } from 'stream';

const REGION = process.env.AWS_REGION || 'eu-north-1';

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
  private polly = new PollyClient({ region: REGION });

  private buildSSML(text: string, speed?: number) {
    const s = clamp(typeof speed === 'number' ? speed : 1.0, 0.5, 1.5);
    const ratePct = Math.round(s * 100);
    return `<speak><prosody rate="${ratePct}%">${xmlEscape(text.trim())}</prosody></speak>`;
  }

  /**
   * Liefert AudioStream + Metadaten für Streaming-Response
   */
  async synthesizeStream(opts: { text: string; language?: string; voice?: string; format?: string; speed?: number }) {
    const { text, language, voice, format, speed } = opts;
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
        new SynthesizeSpeechCommand({ Engine: 'neural', ...cmdBase }),
      );
    } catch (e: any) {
      // Fallback: wenn neural nicht unterstützt wird, auf standard zurückfallen
      const msg = String(e?.message || e);
      const name = String(e?.name || e?.Code || '');
      if (name.toLowerCase().includes('engine') || msg.toLowerCase().includes('neural')) {
        res = await this.polly.send(
          new SynthesizeSpeechCommand({ Engine: 'standard', ...cmdBase }),
        );
      } else {
        throw e;
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
  async synthesizeBase64(opts: { text: string; language?: string; voice?: string; format?: string; speed?: number }) {
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
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
