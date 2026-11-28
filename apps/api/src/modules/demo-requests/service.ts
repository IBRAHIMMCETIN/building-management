import { randomUUID } from 'node:crypto';
import { type MetricsEmitter, noopMetrics } from '../../observability/metrics.js';
import { maskIp, truncateUserAgent } from '../audit/context.js';
import { ValidationError } from '../core/validation.js';
import {
  DEMO_REQUEST_INDEX_PK,
  DEMO_REQUEST_RETENTION_DAYS,
  type DemoRequestItem,
  type DemoRequestRepository,
  createDemoRequestRepository,
  demoRequestKeys,
} from './repository.js';
import { demoRequestInputSchema, describeIssues } from './schema.js';
import { type DemoThrottle, createDemoThrottle } from './throttle.js';

/** Dogrulama hatasi: 400 + alan mesajlari. */
export class DemoRequestValidationError extends ValidationError {
  constructor(
    message: string,
    field: string | undefined,
    readonly fields: Record<string, string>,
  ) {
    super(message, field);
    this.name = 'DemoRequestValidationError';
  }
}

export type DemoRequestMeta = {
  /** API Gateway `requestContext.http.sourceIp` (yerelde istek basligi). */
  sourceIp?: string;
  userAgent?: string;
};

/** Platform listesinde donen alanlar (ic anahtarlar, User-Agent ve TTL yok). */
export type DemoRequestView = Pick<
  DemoRequestItem,
  'requestId' | 'fullName' | 'email' | 'phone' | 'organization' | 'unitRange' | 'message' | 'kvkkVersion' | 'status' | 'createdAt' | 'ipMasked'
>;

export const LIST_DEFAULT_LIMIT = 25;
export const LIST_MAX_LIMIT = 100;

function view(item: DemoRequestItem): DemoRequestView {
  return {
    requestId: item.requestId,
    fullName: item.fullName,
    email: item.email,
    ...(item.phone ? { phone: item.phone } : {}),
    organization: item.organization,
    unitRange: item.unitRange,
    ...(item.message ? { message: item.message } : {}),
    kvkkVersion: item.kvkkVersion,
    status: item.status,
    createdAt: item.createdAt,
    ...(item.ipMasked ? { ipMasked: item.ipMasked } : {}),
  };
}

/**
 * Tanitim sayfasindaki demo talepleri.
 *
 * Akis (ucuz kontroller once, DynamoDB'ye en son gidilir):
 *  1. Kati sema (400): bilinmeyen alan, uzunluk, kontrol karakteri, KVKK onayi ve metin surumu.
 *  2. Bal kupu dolu: kayit YAZILMAZ, sayaca dokunulmaz, gercek yanitla ayni 201 doner (bot ogrenemez).
 *  3. IP ve platform sayaclari (429 + Retry-After).
 *  4. Kayit (`DEMOREQ#`), 2 yil TTL.
 *
 * "Denetim hafif": kimliksiz yazim hash zincirli denetim gunlugune YAZILMAZ (aktor yok; bir bot
 * platform zincirini buyutemesin). Yerine kisisel veri icermeyen yapilandirilmis log satiri ve EMF
 * metrigi (`DemoRequestReceived`, `DemoRequestRejected`) uretilir. Bildirim: platform yoneticilerine
 * giden bir alici mekanizmasi (outbox olaylari apartman kapsamlidir) ve canli e-posta (SES) olmadigi
 * icin olay yayinlanmaz; talepler platform panelinde listelenir.
 */
export function createDemoRequestService(
  deps: {
    repository?: DemoRequestRepository;
    throttle?: DemoThrottle;
    now?: () => Date;
    newId?: () => string;
    metrics?: MetricsEmitter;
    log?: Pick<Console, 'log'>;
  } = {},
) {
  const repository = deps.repository ?? createDemoRequestRepository();
  const now = deps.now ?? (() => new Date());
  const throttle = deps.throttle ?? createDemoThrottle({ store: repository, now });
  const newId = deps.newId ?? randomUUID;
  const metrics = deps.metrics ?? noopMetrics;
  const log = deps.log ?? console;

  return {
    async create(body: unknown, meta: DemoRequestMeta): Promise<{ received: true }> {
      const parsed = demoRequestInputSchema.safeParse(body);
      if (!parsed.success) {
        const { message, field, fields } = describeIssues(parsed.error);
        metrics.emit({ DemoRequestRejected: 1 }, { msg: 'demo_request_rejected', reason: 'validation', field });
        throw new DemoRequestValidationError(message, field, fields);
      }
      const input = parsed.data;
      const ipMasked = maskIp(meta.sourceIp);

      if (input.website && input.website.trim() !== '') {
        metrics.emit({ DemoRequestRejected: 1 }, { msg: 'demo_request_rejected', reason: 'honeypot', ...(ipMasked ? { ipMasked } : {}) });
        return { received: true };
      }

      try {
        await throttle.consume(meta.sourceIp);
      } catch (err) {
        metrics.emit({ DemoRequestRejected: 1 }, { msg: 'demo_request_rejected', reason: 'rate_limited', ...(ipMasked ? { ipMasked } : {}) });
        throw err;
      }

      const at = now();
      const createdAt = at.toISOString();
      const requestId = newId();
      const userAgent = truncateUserAgent(meta.userAgent);
      const item: DemoRequestItem = {
        ...demoRequestKeys(requestId),
        entityType: 'DEMO_REQUEST',
        requestId,
        fullName: input.fullName,
        email: input.email,
        ...(input.phone ? { phone: input.phone } : {}),
        organization: input.organization,
        unitRange: input.unitRange,
        ...(input.message ? { message: input.message } : {}),
        kvkkConsent: true,
        kvkkVersion: input.kvkkVersion,
        status: 'new',
        ...(ipMasked ? { ipMasked } : {}),
        ...(userAgent ? { userAgent } : {}),
        createdAt,
        ttl: Math.floor(at.getTime() / 1000) + DEMO_REQUEST_RETENTION_DAYS * 24 * 60 * 60,
        GSI1PK: DEMO_REQUEST_INDEX_PK,
        GSI1SK: `${createdAt}#${requestId}`,
      };
      await repository.put(item);
      // Kisisel veri (ad, e-posta, telefon, mesaj) loga yazilmaz.
      metrics.emit({ DemoRequestReceived: 1 }, { msg: 'demo_request_received', requestId, unitRange: input.unitRange });
      log.log(JSON.stringify({ msg: 'demo_request_stored', requestId, unitRange: input.unitRange, ...(ipMasked ? { ipMasked } : {}) }));
      return { received: true };
    },

    async list(query: { limit?: string; cursor?: string }): Promise<{ items: DemoRequestView[]; nextCursor?: string }> {
      let limit = LIST_DEFAULT_LIMIT;
      if (query.limit !== undefined) {
        const n = Number(query.limit);
        if (!Number.isInteger(n) || n < 1 || n > LIST_MAX_LIMIT) throw new ValidationError(`limit 1-${LIST_MAX_LIMIT} araliginda olmalidir`, 'limit');
        limit = n;
      }
      const page = await repository.list({ limit, ...(query.cursor ? { cursor: query.cursor } : {}) });
      return { items: page.items.map(view), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
  };
}

export type DemoRequestService = ReturnType<typeof createDemoRequestService>;
