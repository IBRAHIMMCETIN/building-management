import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type MetricsEmitter, noopMetrics } from '../../observability/metrics.js';
import { maskIp } from '../audit/context.js';
import { ValidationError } from '../core/validation.js';
import { type IpMacer, DemoUnavailableError, loadIpMacer } from './ipMac.js';
import {
  DEMO_REQUEST_INDEX_PK,
  DEMO_REQUEST_RETENTION_DAYS,
  type DemoRequestItem,
  type DemoRequestRepository,
  createDemoRequestRepository,
  demoRequestKeys,
} from './repository.js';
import { HONEYPOT_FIELD, demoRequestInputSchema, describeIssues } from './schema.js';
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

export class DemoRequestNotFoundError extends Error {
  readonly code = 'not_found' as const;
  readonly httpStatus = 404 as const;
  constructor() {
    super('Demo talebi bulunamadı veya zaten kaldırılmış');
    this.name = 'DemoRequestNotFoundError';
  }
}

export type DemoRequestMeta = {
  /** API Gateway `requestContext.http.sourceIp` (yerelde istek basligi). */
  sourceIp?: string;
};

/** Platform listesinde donen alanlar (ic anahtarlar ve TTL yok). */
export type DemoRequestView = {
  requestId: string;
  fullName: string;
  email: string;
  phone?: string;
  organization: string;
  unitRange: DemoRequestItem['unitRange'];
  message?: string;
  kvkkVersion: string;
  status: 'new';
  suspect?: true;
  createdAt: string;
  ipMasked?: string;
};

export const LIST_DEFAULT_LIMIT = 25;
export const LIST_MAX_LIMIT = 100;

const eraseSchema = z.strictObject({
  status: z.enum(['deleted', 'spam'], { error: 'status deleted veya spam olmalidir' }),
  reason: z
    .string({ error: 'Gerekce metin olmalidir' })
    .trim()
    .min(10, 'Gerekce en az 10 karakter olmalidir')
    .max(500, 'Gerekce en fazla 500 karakter olabilir'),
});

function view(item: DemoRequestItem): DemoRequestView {
  return {
    requestId: item.requestId,
    fullName: item.fullName ?? '',
    email: item.email ?? '',
    ...(item.phone ? { phone: item.phone } : {}),
    organization: item.organization ?? '',
    unitRange: item.unitRange,
    ...(item.message ? { message: item.message } : {}),
    kvkkVersion: item.kvkkVersion,
    status: 'new',
    ...(item.suspect ? { suspect: true as const } : {}),
    createdAt: item.createdAt,
    ...(item.ipMasked ? { ipMasked: item.ipMasked } : {}),
  };
}

/**
 * Tanitim sayfasindaki demo talepleri.
 *
 * Akis (ucuz kontroller once, DynamoDB'ye en son gidilir):
 *  1. Kati sema (400): bilinmeyen alan, uzunluk, kontrol karakteri, KVKK onayi ve bilinen metin surumu.
 *  2. Bal kupu dolu: kayit YAZILMAZ, sayaca dokunulmaz, gercek yanitla ayni 201 doner (bot ogrenemez).
 *  3. Istemci, ag ve platform sayaclari (429 + Retry-After); platform olagan hacmi asildiysa `suspect`.
 *  4. Kayit (`DEMOREQ#`), 2 yil TTL. User-Agent saklanmaz.
 *
 * "Denetim hafif": kimliksiz yazim hash zincirli denetim gunlugune YAZILMAZ (aktor yok; bir bot
 * platform zincirini buyutemesin). Yerine kisisel veri icermeyen log satiri ve EMF metrikleri
 * (`DemoRequestReceived`, `DemoRequestRejected`, `DemoRequestSuspect`). Platform yoneticisinin silme /
 * spam islemi ise platform zincirine yazilir. Bildirim: platform yoneticilerine giden bir alici
 * mekanizmasi ve canli e-posta (SES) olmadigi icin olay yayinlanmaz; talepler platform panelinde.
 */
export function createDemoRequestService(
  deps: {
    repository?: DemoRequestRepository;
    throttle?: DemoThrottle;
    macer?: IpMacer;
    now?: () => Date;
    newId?: () => string;
    metrics?: MetricsEmitter;
    log?: Pick<Console, 'log'>;
  } = {},
) {
  const repository = deps.repository ?? createDemoRequestRepository();
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const metrics = deps.metrics ?? noopMetrics;
  const log = deps.log ?? console;
  // Production'da HMAC anahtari yoksa (yapilandirma hatasi) form 503 doner; zayif ozete dusulmez.
  const macer = deps.macer ?? loadIpMacer();
  const throttle = deps.throttle ?? (macer ? createDemoThrottle({ store: repository, macer, now }) : undefined);

  return {
    async create(body: unknown, meta: DemoRequestMeta): Promise<{ received: true }> {
      const parsed = demoRequestInputSchema.safeParse(body);
      if (!parsed.success) {
        const { message, field, fields } = describeIssues(parsed.error);
        // Yalnizca semadaki alan adlari (ya da sabit `_unknown` / `_body`) loga yazilir.
        metrics.emit({ DemoRequestRejected: 1 }, { msg: 'demo_request_rejected', reason: 'validation', field: field ?? '_body' });
        throw new DemoRequestValidationError(message, field, fields);
      }
      const input = parsed.data;
      const ipMasked = maskIp(meta.sourceIp);

      const trap = input[HONEYPOT_FIELD];
      if (trap && trap.trim() !== '') {
        metrics.emit({ DemoRequestRejected: 1 }, { msg: 'demo_request_rejected', reason: 'honeypot', ...(ipMasked ? { ipMasked } : {}) });
        return { received: true };
      }

      if (!throttle) throw new DemoUnavailableError();
      let suspect = false;
      try {
        ({ suspect } = await throttle.consume(meta.sourceIp));
      } catch (err) {
        if (err instanceof DemoUnavailableError) throw err;
        metrics.emit({ DemoRequestRejected: 1 }, { msg: 'demo_request_rejected', reason: 'rate_limited', ...(ipMasked ? { ipMasked } : {}) });
        throw err;
      }

      const at = now();
      const createdAt = at.toISOString();
      const requestId = newId();
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
        ...(suspect ? { suspect: true as const } : {}),
        ...(ipMasked ? { ipMasked } : {}),
        createdAt,
        ttl: Math.floor(at.getTime() / 1000) + DEMO_REQUEST_RETENTION_DAYS * 24 * 60 * 60,
        GSI1PK: DEMO_REQUEST_INDEX_PK,
        GSI1SK: `${createdAt}#${requestId}`,
      };
      await repository.put(item);
      // Kisisel veri (ad, e-posta, telefon, mesaj) loga yazilmaz.
      metrics.emit({ DemoRequestReceived: 1, ...(suspect ? { DemoRequestSuspect: 1 } : {}) }, { msg: 'demo_request_received', requestId, unitRange: input.unitRange, suspect });
      log.log(JSON.stringify({ msg: 'demo_request_stored', requestId, unitRange: input.unitRange, suspect, ...(ipMasked ? { ipMasked } : {}) }));
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

    /**
     * KVKK silme talebi (`deleted`) veya istenmeyen kayit (`spam`): kisisel alanlar kaldirilir, kayit
     * listeden duser, TTL kalir. Platform denetim zincirine gerekceyle yazilir (ayni atomik yazim).
     */
    async erase(actorId: string, requestId: string, body: unknown): Promise<{ requestId: string; status: 'deleted' | 'spam' }> {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(requestId)) throw new DemoRequestNotFoundError();
      const parsed = eraseSchema.safeParse(body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue && issue.code !== 'unrecognized_keys' ? String(issue.path[0] ?? '_body') : '_unknown';
        throw new ValidationError(issue?.code === 'unrecognized_keys' ? 'Bilinmeyen alan' : (issue?.message ?? 'Gecersiz istek'), field);
      }
      const { status, reason } = parsed.data;
      const done = await repository.erase(
        { requestId, status, at: now().toISOString(), by: actorId },
        { action: status === 'spam' ? 'demo_request.spam' : 'demo_request.erase', target: { type: 'demo_request', id: requestId }, reason, details: { status } },
      );
      if (!done) throw new DemoRequestNotFoundError();
      return { requestId, status };
    },
  };
}

export type DemoRequestService = ReturnType<typeof createDemoRequestService>;
