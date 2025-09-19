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
import * as crypto from 'crypto';

const REGION = process.env.AWS_REGION || 'eu-north-1';
const INBOX_BUCKET = process.env.INBOX_BUCKET || '';
const RESULTS_BUCKET = process.env.RESULTS_BUCKET || '';
const QUEUE_URL = process.env.SQS_QUEUE_URL ?? process.env.QUEUE_URL ?? '';
const TABLE_NAME = process.env.TABLE_NAME || '';
const ASSET_URL_MODE = process.env.ASSET_URL_MODE || 'asset';

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
  'pt_br': 'pt-Br',
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

const LANGUAGE_LABEL_MAP: Record<string, string> = {
  en: 'English',
  de: 'German',
  es: 'Spanish',
  fr: 'French',
  ja: 'Japanese',
  ko: 'Korean',
  ru: 'Russian',
  'pt-Br': 'Brazilian Portuguese',
  it: 'Italian',
};

function normalizeLanguage(lang?: string) {
  if (!lang) return 'unknown';
  const key = lang.trim().toLowerCase();
  return LANG_MAP[key] ?? lang;
}

function buildImageLanguageDirective(lang: string) {
  if (lang === 'unknown') {
    return 'Render the image without any text or lettering. If text is unavoidable, prefer symbols or signage without words.';
  }
  const friendlyName = LANGUAGE_LABEL_MAP[lang] ?? lang;
  return `Render any visible text strictly in ${friendlyName}. Ignore or replace prompt terms in other languages.`;
}

@Injectable()
export class AppService {
  private s3 = new S3Client({ region: REGION });
  private sqs = new SQSClient({ region: REGION });
  private db = new DynamoDBClient({ region: REGION });

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
  async enqueueJob(jobId: string, s3Key: string, ocr?: boolean, language?: string) {
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
    const imagePromptLanguageRule = buildImageLanguageDirective(lang);

    const message = {
      jobId,
      s3Key,
      bucket: INBOX_BUCKET,
      resultsBucket: RESULTS_BUCKET,
      // keep a top-level language for legacy workers
      language: lang,
      imagePromptLanguageRule,
      options: {
        ocr: !!ocr,
        language: lang,
        imagePromptLanguageRule,
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
