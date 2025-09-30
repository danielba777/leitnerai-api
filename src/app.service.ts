import { BadRequestException, Injectable } from '@nestjs/common';
import * as os from 'os';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import * as crypto from 'crypto';
import { TextDecoder } from 'util';

const REGION = process.env.AWS_REGION || 'eu-north-1';
const INBOX_BUCKET = process.env.INBOX_BUCKET || '';
const RESULTS_BUCKET = process.env.RESULTS_BUCKET || '';
const QUEUE_URL = process.env.SQS_QUEUE_URL ?? process.env.QUEUE_URL ?? '';
const TABLE_NAME = process.env.TABLE_NAME || '';
const ASSET_URL_MODE = process.env.ASSET_URL_MODE || 'asset';
const OPENAI_API_URL =
  process.env.OPENAI_API_URL || 'https://api.openai.com/v1/responses';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5';
const BEDROCK_REGION =
  process.env.BEDROCK_REGION || process.env.AWS_REGION || 'eu-north-1';
const BEDROCK_INFERENCE_PROFILE_ARN =
  process.env.BEDROCK_INFERENCE_PROFILE_ARN || '';
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || '';

function s3PublicUrl(bucket: string, region: string, key: string) {
  const escaped = key.split('/').map(encodeURIComponent).join('/');
  return `https://${bucket}.s3.${region}.amazonaws.com/${escaped}`;
}

if (!QUEUE_URL) {
  throw new Error('SQS_QUEUE_URL/QUEUE_URL is not set');
}

// Sprach-Normalisierung (einfach & robust)
const LANG_MAP: Record<string, string> = {
  en: 'en',
  english: 'en',
  englisch: 'en',
  de: 'de',
  german: 'de',
  deutsch: 'de',
  es: 'es',
  spanish: 'es',
  spanisch: 'es',
  fr: 'fr',
  french: 'fr',
  französisch: 'fr',
  ja: 'ja',
  japanese: 'ja',
  japanisch: 'ja',
  ko: 'ko',
  korean: 'ko',
  koreanisch: 'ko',
  'pt-br': 'pt-Br',
  pt_br: 'pt-Br',
  pt: 'pt-Br',
  portuguese: 'pt-Br',
  portugiesisch: 'pt-Br',
  it: 'it',
  italian: 'it',
  italienisch: 'it',
  ru: 'ru',
  russian: 'ru',
  russisch: 'ru',
  unknown: 'unknown',
};

function normalizeLanguage(lang?: string) {
  if (!lang) return 'unknown';
  const key = lang.trim().toLowerCase();
  return LANG_MAP[key] ?? lang;
}

const TEACHER_SYSTEM_PROMPT = `
You’re a college teacher expert with a knack for writing gritty, heartfelt handouts that students actually read.
Rewrite the provided text so it feels like it came straight from your pen—raw, real, and human.
Make it professional but warm, like you’re talking to your students (18–20 years old) about something that’ll help them in school.

Do this:
• Write like you’re scribbling notes before class: short sentences, then a long ramble. Toss in a random thought, like “I saw this go wrong in my algebra class.”
• Drop in a quick story about a student or a school moment, like forgetting a deadline or nailing a tough quiz. Make it specific but messy, not polished.
• Skip fancy words or smooth transitions. Say “Look,” “Trust me,” or “Here’s the kicker” instead of “therefore” or “additionally.”
• Make it feel like a teacher’s advice—think tips for surviving essays or cramming for science. Mention real stuff, like late-night study sessions or a messy backpack.
• Change up paragraph sizes: one line here, a big chunk there. Throw in a question like “Ever bombed a test?” to sound human.
• Don’t sound too perfect. Add a quirk, like admitting you’re bad at remembering names, to keep the tone personal and real.

Output as a single paragraph (no line breaks). Do not use em dashes (—); use a normal hyphen (-) instead.
`.trim();

@Injectable()
export class AppService {
  private s3 = new S3Client({ region: REGION });
  private sqs = new SQSClient({ region: REGION });
  private db = new DynamoDBClient({ region: REGION });
  // Bedrock Runtime Client
  private bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });

  // --- Normalisierung: keine Em-Dashes, keine Zeilenumbrüche, Whitespaces sauber ---
  private normalizeOutput(raw: string): string {
    if (!raw) return '';
    return raw
      .replace(/\u2014/g, '-')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  private pickOutputText(data: any): string {
    if (typeof data?.output_text === 'string' && data.output_text.trim()) {
      return data.output_text;
    }

    if (
      typeof data?.response?.output_text === 'string' &&
      data.response.output_text.trim()
    ) {
      return data.response.output_text;
    }

    const outputs: any[] = [];
    if (Array.isArray(data?.output)) {
      outputs.push(...data.output);
    }
    if (Array.isArray(data?.response?.output)) {
      outputs.push(...data.response.output);
    }

    const chunks: string[] = [];

    for (const item of outputs) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const c of content) {
        if (c?.type === 'output_text' && typeof c?.text === 'string') {
          chunks.push(c.text);
        } else if (c?.type === 'text' && typeof c?.text === 'string') {
          chunks.push(c.text);
        }
      }
    }

    if (chunks.length) {
      return chunks.join('');
    }

    if (typeof data?.choices?.[0]?.message?.content === 'string') {
      return data.choices[0].message.content;
    }

    return '';
  }

  private async bedrockClaudeMessages(params: {
    system: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
  }) {
    const { system, user } = params;
    const temperature =
      typeof params.temperature === 'number' ? params.temperature : 0.6;
    const maxTokens =
      typeof params.maxTokens === 'number' ? params.maxTokens : 1024;

    if (!BEDROCK_INFERENCE_PROFILE_ARN && !BEDROCK_MODEL_ID) {
      throw new BadRequestException(
        'Bedrock not configured: set BEDROCK_INFERENCE_PROFILE_ARN or BEDROCK_MODEL_ID',
      );
    }

    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      temperature,
      top_p: 0.9,
      max_tokens: maxTokens,
    };

    const modelIdForCall =
      BEDROCK_INFERENCE_PROFILE_ARN &&
      BEDROCK_INFERENCE_PROFILE_ARN.trim().length > 0
        ? BEDROCK_INFERENCE_PROFILE_ARN
        : BEDROCK_MODEL_ID;

    if (!modelIdForCall) {
      throw new BadRequestException(
        'Bedrock not configured: set BEDROCK_INFERENCE_PROFILE_ARN or BEDROCK_MODEL_ID',
      );
    }

    const resp = await this.bedrock.send(
      new InvokeModelCommand({
        modelId: modelIdForCall,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      }),
    );

    const jsonStr =
      typeof resp.body === 'string'
        ? resp.body
        : new TextDecoder('utf-8').decode(resp.body as Uint8Array);

    const data = JSON.parse(jsonStr);

    const pieces = Array.isArray(data?.content)
      ? data.content
          .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
          .filter(Boolean)
      : [];

    return pieces.join('');
  }

  getHello(): string {
    return 'Hello World!';
  }

  getPrivateIpOrHostname(): string {
    const nics = os.networkInterfaces();
    for (const k of Object.keys(nics)) {
      for (const e of nics[k] ?? []) {
        if (!e.internal && e.family === 'IPv4') return `${e.address} - Daniel`;
      }
    }
    return `${os.hostname()} - Daniel`;
  }

  // ---- Upload-URL (Presigned PUT) ----
  async createUploadUrl(filename: string) {
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_') || 'file.pdf';
    const jobId = crypto.randomUUID();
    const key = `uploads/${jobId}_${safe}`;

    const cmd = new PutObjectCommand({
      Bucket: INBOX_BUCKET,
      Key: key,
      ContentType: 'application/pdf',
    });

    const url = await getSignedUrl(this.s3, cmd, { expiresIn: 900 });
    return { jobId, key, url };
  }

  // ---- Job einstellen (DDB + SQS) ----
  async enqueueJob(
    jobId: string,
    s3Key: string,
    ocr?: boolean,
    language?: string,
  ) {
    if (!s3Key.startsWith('uploads/')) {
      throw new BadRequestException('s3Key must start with "uploads/".');
    }
    // Objekt existiert?
    await this.s3.send(
      new HeadObjectCommand({ Bucket: INBOX_BUCKET, Key: s3Key }),
    );

    await this.db.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          jobId: { S: jobId },
          status: { S: 'queued' },
          s3Key: { S: s3Key },
          createdAt: { N: String(Date.now()) },
          // optional: ttl: { N: String(Math.floor(Date.now()/1000) + 7*24*3600) }
        },
        // kein overwrite-schutz fürs MVP
      }),
    );

    const lang = normalizeLanguage(language);

    const message = {
      jobId,
      s3Key,
      bucket: INBOX_BUCKET,
      resultsBucket: RESULTS_BUCKET,
      // keep a top-level language for legacy workers
      language: lang,
      options: {
        ocr: !!ocr,
        language: lang,
      },
    };

    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(message),
      }),
    );

    return { jobId, language: lang };
  }

  async rewrite(body: { text: string; model?: string; temperature?: number }) {
    const text = (body.text || '').trim();
    if (!text) {
      throw new BadRequestException('text required');
    }

    const systemPrompt = TEACHER_SYSTEM_PROMPT;

    const userContent = [
      `Input Text:\n${text}`,
      'Task: Rewrite the text to sound like a teacher’s honest, unpolished advice for students. Make it professional but real, like it’s for a handout or blog post.',
      'If no text is given, write a short bit about why planning ahead helps with schoolwork, using the same rules.',
      'Output Format: Give the text as a rough, engaging piece for students, like a quick classroom note or study tip.',
    ].join('\n\n');

    const temperature =
      typeof body.temperature === 'number' ? body.temperature : 0.6;

    let raw = '';
    try {
      raw = await this.bedrockClaudeMessages({
        system: systemPrompt,
        user: userContent,
        temperature,
        maxTokens: 2048,
      });
    } catch (e: any) {
      throw new BadRequestException(`Bedrock error: ${e?.message || e}`);
    }

    const output = this.normalizeOutput(raw);

    const modelDescriptor =
      BEDROCK_INFERENCE_PROFILE_ARN || BEDROCK_MODEL_ID || 'bedrock:anthropic:sonnet-4';

    return {
      provider: 'bedrock',
      model: modelDescriptor,
      output,
    };
  }

  // ---- Status lesen ----
  async getStatus(jobId: string) {
    const res = await this.db.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { jobId: { S: jobId } },
        ConsistentRead: true,
      }),
    );
    const i = res.Item ?? {};
    return {
      jobId,
      status: i.status?.S ?? 'unknown',
      resultKey: i.resultKey?.S,
      error: i.error?.S,
      resultsBucket: i.resultsBucket?.S,
      publicJsonUrl: i.publicJsonUrl?.S,
    };
  }

  // ---- Presigned GET fürs Ergebnis (optional) ----
  async getResultDownloadUrl(jobId: string) {
    const isFinished = (val?: string) =>
      (val ?? '').toLowerCase() === 'done' ||
      (val ?? '').toLowerCase() === 'completed' ||
      (val ?? '').toLowerCase() === 'success';

    const s = await this.getStatus(jobId);
    if (!isFinished(s.status) || !s.resultKey) {
      throw new BadRequestException('Job not finished or no resultKey.');
    }

    if (s.publicJsonUrl) {
      return { url: s.publicJsonUrl, resultKey: s.resultKey };
    }

    const bucket = s.resultsBucket || RESULTS_BUCKET || INBOX_BUCKET;

    if (ASSET_URL_MODE === 's3-public') {
      const url = s3PublicUrl(bucket, REGION, s.resultKey);
      return { url, resultKey: s.resultKey };
    }

    const cmd = new GetObjectCommand({
      Bucket: bucket,
      Key: s.resultKey,
    });
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: 900 });
    return { url, resultKey: s.resultKey };
  }

  async getAssetSignedUrl(key: string) {
    if (!key.startsWith('results/')) {
      throw new BadRequestException('key must start with "results/".');
    }

    const cmd = new GetObjectCommand({
      Bucket: RESULTS_BUCKET,
      Key: key,
    });
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: 900 });
    return { url };
  }

  // ---- Health ----
  health() {
    return { ok: true };
  }
}
