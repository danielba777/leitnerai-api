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

if (!QUEUE_URL) {
  throw new Error('SQS_QUEUE_URL/QUEUE_URL is not set');
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
  async enqueueJob(jobId: string, s3Key: string, ocr?: boolean) {
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

    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify({
          jobId,
          s3Key,
          bucket: INBOX_BUCKET,
          resultsBucket: RESULTS_BUCKET,
          options: { ocr: !!ocr },
        }),
      }),
    );

    return { jobId };
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
    };
  }

  // ---- Presigned GET fürs Ergebnis (optional) ----
  async getResultDownloadUrl(jobId: string) {
    const s = await this.getStatus(jobId);
    const st = (s.status ?? '').toString().toLowerCase();
    if (!['done', 'completed', 'success'].includes(st) || !s.resultKey) {
      throw new BadRequestException('Job not finished or no resultKey.');
    }
    const cmd = new GetObjectCommand({
      Bucket: RESULTS_BUCKET,
      Key: s.resultKey,
    });
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: 900 });
    return { jobId, url };
  }

  // ---- Health ----
  health() {
    return { ok: true };
  }
}
