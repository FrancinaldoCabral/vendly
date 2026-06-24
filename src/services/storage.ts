/**
 * storage.ts — File storage on MinIO (S3-compatible). The operator installs MinIO and
 * sets MINIO_* env vars; this uploads buffers and returns a public URL. If not configured,
 * uploads fail with a clear message (the client can still paste a public URL by hand).
 */
import { Client } from 'minio';
import { config } from '../config.js';

let client: Client | null = null;

export function storageConfigured(): boolean {
  const m = config.minio;
  return !!(m.endpoint && m.accessKey && m.secretKey && m.bucket);
}

function getClient(): Client {
  if (client) return client;
  const m = config.minio;
  client = new Client({
    endPoint: m.endpoint,
    port: m.port,
    useSSL: m.useSSL,
    accessKey: m.accessKey,
    secretKey: m.secretKey,
  });
  return client;
}

async function ensureBucket(): Promise<void> {
  const c = getClient();
  const bucket = config.minio.bucket;
  const exists = await c.bucketExists(bucket).catch(() => false);
  if (!exists) {
    await c.makeBucket(bucket);
    // Public-read policy so the generated URLs are reachable by WhatsApp/Evolution.
    const policy = {
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow', Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/*`],
      }],
    };
    await c.setBucketPolicy(bucket, JSON.stringify(policy)).catch(() => { /* non-fatal */ });
  }
}

/** Upload a file buffer and return its public URL. */
export async function uploadFile(
  tenantId: string,
  fileName: string,
  contentType: string,
  data: Buffer,
): Promise<string> {
  if (!storageConfigured()) {
    throw new Error('Armazenamento de arquivos não está configurado. Cole a URL pública do arquivo ou configure o MinIO.');
  }
  await ensureBucket();
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'arquivo';
  // Store under the `public/` prefix — that's the only path this MinIO serves publicly, so the
  // returned URL is reachable by WhatsApp/Evolution/the browser.
  const key = `public/${tenantId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
  const bucket = config.minio.bucket;
  await getClient().putObject(bucket, key, data, data.length, { 'Content-Type': contentType || 'application/octet-stream' });
  // Mark the object public-read (mirrors the chat-server uploader on the same MinIO).
  await getClient().setObjectTagging(bucket, key, { acl: 'public-read' }).catch(() => { /* non-fatal */ });

  const m = config.minio;
  if (m.publicBaseUrl) return `${m.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  const scheme = m.useSSL ? 'https' : 'http';
  const portPart = (m.useSSL && m.port === 443) || (!m.useSSL && m.port === 80) ? '' : `:${m.port}`;
  return `${scheme}://${m.endpoint}${portPart}/${m.bucket}/${key}`;
}
