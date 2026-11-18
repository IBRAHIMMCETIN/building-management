import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DocumentError } from './errors.js';

/**
 * Private belge deposu. Istemci dosyaya hicbir zaman dogrudan erismez: API yetkiyi dogrular
 * ve kisa omurlu imzali (pre-signed) URL uretir.
 */
export type StoredObject = { size: number; contentType?: string };

export type DocumentStore = {
  head(key: string): Promise<StoredObject | undefined>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Ayni bucket icinde kopya (gecici yuklemeyi kalici yere tasimak icin). */
  copy(fromKey: string, toKey: string): Promise<void>;
  presignGet(key: string, options: { contentDisposition: string; contentType: string; expiresIn: number }): Promise<string>;
  /**
   * Tarayicidan dogrudan yukleme. `Content-Type` ve `Content-Length` imzalanir: istemci ayni
   * turu ve bildirdigi boyutta dosyayi gondermelidir (boyut siniri yuklemede de gecerli olur).
   */
  presignPut(key: string, options: { contentType: string; contentLength: number; expiresIn: number }): Promise<string>;
};

/** Imzali URL omru (saniye). Proje kurali: kisa sureli. */
export const URL_TTL_SECONDS = 300;

function storageError(op: string, err: unknown): DocumentError {
  const name = err instanceof Error ? err.name : 'unknown';
  return new DocumentError('storage_error', `Belge deposu hatasi (${op}: ${name})`, { cause: err });
}

export function createS3DocumentStore(config: { bucket: string; region?: string; client?: S3Client }): DocumentStore {
  const client = config.client ?? new S3Client(config.region ? { region: config.region } : {});
  const Bucket = config.bucket;

  return {
    async head(key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: out.ContentLength ?? 0, contentType: out.ContentType };
      } catch (err) {
        // ListBucket yetkisi oldugu icin yok olan nesne 403 degil 404 (NotFound) doner.
        if (err instanceof NotFound || err instanceof NoSuchKey) return undefined;
        if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404) return undefined;
        throw storageError('head', err);
      }
    },

    async put(key, body, contentType) {
      try {
        await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
      } catch (err) {
        throw storageError('put', err);
      }
    },

    async copy(fromKey, toKey) {
      try {
        await client.send(
          new CopyObjectCommand({
            Bucket,
            Key: toKey,
            CopySource: `${Bucket}/${fromKey.split('/').map(encodeURIComponent).join('/')}`,
            MetadataDirective: 'COPY',
          }),
        );
      } catch (err) {
        if (err instanceof NoSuchKey) throw new DocumentError('unprocessable', 'Kopyalanacak dosya bulunamadi');
        throw storageError('copy', err);
      }
    },

    async presignGet(key, { contentDisposition, contentType, expiresIn }) {
      try {
        return await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket, Key: key, ResponseContentDisposition: contentDisposition, ResponseContentType: contentType }),
          { expiresIn },
        );
      } catch (err) {
        throw storageError('presign-get', err);
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

/** DOCUMENTS_BUCKET yoksa depo kapalidir (yerel gelistirme); belge uclari 503 doner. */
export function createDocumentStoreFromEnv(env: NodeJS.ProcessEnv = process.env): DocumentStore | undefined {
  const bucket = env.DOCUMENTS_BUCKET?.trim();
  if (!bucket) return undefined;
  return createS3DocumentStore({ bucket, region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION });
}

/** Testler icin bellek ici depo (imzali URL yerine okunabilir sahte URL). */
export function createMemoryDocumentStore() {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const store: DocumentStore = {
    head: async (key) => {
      const o = objects.get(key);
      return o ? { size: o.body.byteLength, contentType: o.contentType } : undefined;
    },
    put: async (key, body, contentType) => {
      objects.set(key, { body, contentType });
    },
    copy: async (from, to) => {
      const o = objects.get(from);
      if (!o) throw new DocumentError('unprocessable', 'Kopyalanacak dosya bulunamadi');
      objects.set(to, o);
    },
    presignGet: async (key, o) => `memory://get/${key}?ttl=${o.expiresIn}&cd=${encodeURIComponent(o.contentDisposition)}`,
    presignPut: async (key, o) => `memory://put/${key}?ttl=${o.expiresIn}&ct=${encodeURIComponent(o.contentType)}&len=${o.contentLength}`,
  };
  return { store, objects };
}
