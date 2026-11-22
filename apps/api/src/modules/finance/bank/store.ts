import {
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BankError } from './errors.js';

/**
 * Ekstre dosyalari (private belge bucket'i, `apartments/{apt}/bank-statements/...`). Tarayici
 * yalnizca kisa omurlu imzali PUT ile yukler; dosyayi API okur. Silme yok.
 */
export type BankFileStore = {
  head(key: string): Promise<{ size: number; contentType?: string } | undefined>;
  getBytes(key: string, maxBytes: number): Promise<Uint8Array | undefined>;
  presignPut(key: string, options: { contentType: string; contentLength: number; expiresIn: number }): Promise<string>;
};

export const UPLOAD_URL_TTL_SECONDS = 300;

const storageError = (op: string, err: unknown) =>
  new BankError('storage_error', `Dosya deposu hatasi (${op}: ${err instanceof Error ? err.name : 'unknown'})`, undefined, { cause: err });

const isMissing = (err: unknown) =>
  err instanceof NotFound || err instanceof NoSuchKey || (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404);

export function createS3BankFileStore(config: { bucket: string; region?: string; client?: S3Client }): BankFileStore {
  const client = config.client ?? new S3Client(config.region ? { region: config.region } : {});
  const Bucket = config.bucket;
  return {
    async head(key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: out.ContentLength ?? 0, contentType: out.ContentType };
      } catch (err) {
        if (isMissing(err)) return undefined;
        throw storageError('head', err);
      }
    },
    async getBytes(key, maxBytes) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        if ((out.ContentLength ?? 0) > maxBytes) throw new BankError('too_large', `Dosya en fazla ${Math.round(maxBytes / 1024 / 1024)} MB olabilir`);
        const bytes = await out.Body?.transformToByteArray();
        if (bytes && bytes.byteLength > maxBytes) throw new BankError('too_large', `Dosya en fazla ${Math.round(maxBytes / 1024 / 1024)} MB olabilir`);
        return bytes ?? new Uint8Array();
      } catch (err) {
        if (err instanceof BankError) throw err;
        if (isMissing(err)) return undefined;
        throw storageError('get', err);
      }
    },
    async presignPut(key, { contentType, contentLength, expiresIn }) {
      try {
        return await getSignedUrl(client, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType, ContentLength: contentLength }), {
          expiresIn,
          signableHeaders: new Set(['content-type', 'content-length']),
        });
      } catch (err) {
        throw storageError('presign-put', err);
      }
    },
  };
}

/** DOCUMENTS_BUCKET yoksa (yerel) depo kapalidir; yukleme/onizleme uclari 503 doner. */
export function createBankFileStoreFromEnv(env: NodeJS.ProcessEnv = process.env): BankFileStore | undefined {
  const bucket = env.DOCUMENTS_BUCKET?.trim();
  if (!bucket) return undefined;
  return createS3BankFileStore({ bucket, region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION });
}

/** Testler ve yerel gelistirme icin bellek ici depo. */
export function createMemoryBankFileStore() {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const store: BankFileStore = {
    head: async (key) => {
      const o = objects.get(key);
      return o ? { size: o.body.byteLength, contentType: o.contentType } : undefined;
    },
    getBytes: async (key, maxBytes) => {
      const o = objects.get(key);
      if (!o) return undefined;
      if (o.body.byteLength > maxBytes) throw new BankError('too_large', 'Dosya cok buyuk');
      return o.body;
    },
    presignPut: async (key, o) => `memory://put/${key}?ttl=${o.expiresIn}&ct=${encodeURIComponent(o.contentType)}&len=${o.contentLength}`,
  };
  return { store, objects };
}
