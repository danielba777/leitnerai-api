// src/worker.ts
import { SQSHandler, SQSRecord } from 'aws-lambda';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const REGION = process.env.AWS_REGION || 'eu-north-1';
const TABLE_NAME = process.env.TABLE_NAME || '';

const db = new DynamoDBClient({ region: REGION });

export const handler: SQSHandler = async (event) => {
  const results: Array<{ jobId?: string; ok: boolean; error?: string }> = [];

  for (const record of event.Records) {
    let payload: any = undefined;
    try {
      payload = JSON.parse(record.body);
    } catch (e: any) {
      results.push({ ok: false, error: `invalid JSON: ${e?.message || e}` });
      continue;
    }

    const jobId = payload?.jobId as string | undefined;
    if (!jobId) {
      results.push({ ok: false, error: 'missing jobId' });
      continue;
    }

    try {
      // TODO: Hier deine eigentliche Verarbeitung einfügen:
      // - PDF aus s3://INBOX_BUCKET/<s3Key> holen
      // - OCR/Extract
      // - Ergebnis nach s3://RESULTS_BUCKET/results/...
      // - resultKey ermitteln

      // Platzhalter: markiere als "queued->done" ohne resultKey
      await db.send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: { jobId: { S: jobId } },
          UpdateExpression: 'SET #status = :s, #updatedAt = :t',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':s': { S: 'done' },
            ':t': { N: String(Date.now()) },
          },
        }),
      );

      results.push({ jobId, ok: true });
    } catch (e: any) {
      results.push({ jobId, ok: false, error: e?.message || String(e) });
    }
  }

  // Optionale Log-Zusammenfassung
  console.log(JSON.stringify({ type: 'worker-summary', results }));
};
