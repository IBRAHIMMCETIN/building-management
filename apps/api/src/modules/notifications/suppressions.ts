import { createHash } from 'node:crypto';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DataAccessError, getDynamo, putNewItem, putVersionedItem, toDataAccessError } from '../../config/dynamodb.js';
import { type AuditDraft, auditedPutVersioned } from '../audit/log.js';

/**
 * Bildirim devami: SES geri donus (bounce) / sikayet (complaint) olaylarindan e-posta engeli.
 *
 * Akis (SES canliya alininca): SES kimliginin geri bildirim bildirimleri -> SNS `<yigin>-ses-feedback`
 * topic'i (infra/ses_feedback.tf) -> bildirim worker'i (SNS kaydi; `handleSesFeedback`, yalnizca
 * `SES_FEEDBACK_TOPIC_ARN` topic'inden) -> engel kaydi. E-posta kanali (email.ts) engelli aliciya
 * gondermez (`skipped: suppressed`, `email_suppressed` logu).
 *
 * Kurallar:
 *  - Kalici geri donus (`Permanent`) ve sikayet: hemen, suresiz engel (platform yoneticisi kaldirir).
 *  - Gecici / belirsiz geri donus: `SOFT_BOUNCE_WINDOW_HOURS` saat icinde `SOFT_BOUNCE_LIMIT` kez
 *    olursa `SOFT_BOUNCE_DAYS` gunluk engel; altinda kayit yalnizca izlenir (`observing`, engel yok).
 *  - Icerikten kaynaklanan geri donus (ContentRejected, MessageTooLarge, AttachmentRejected) alicinin
 *    sorunu degildir: yok sayilir.
 *  - Iletilen (forward) postada `bouncedRecipients` son aliciyi (Final-Recipient) gosterebilir: tek
 *    alicili iletide `mail.destination` adresi de ayrica engellenir.
 *
 * Kayit (platform kapsami; e-posta apartmandan bagimsizdir):
 *   PK = `EMAILSUP`, SK = `H#<sha256(kucuk harf adres)>`, `version` (her yazim surum kosullu)
 *   Adresin kendisi saklanmaz: anahtar hash, ekranda yalnizca maskeli bicim (`a***@ornek.com`).
 *   Kaldirma silme degildir: kayit `cleared` olur (denetimli, surum kosullu), 30 gun sonra TTL ile duser.
 * Yaris: tum yazimlar okunan surume kosulludur; cakismada yeniden okunur. Boylece gecici geri donus
 * araya giren kalici engelin ustune yazamaz, kaldirma araya giren yeni kalici engeli silemez (409).
 */

export const SUPPRESSION_PK = 'EMAILSUP';
export const SOFT_BOUNCE_DAYS = 7;
export const SOFT_BOUNCE_LIMIT = 3;
export const SOFT_BOUNCE_WINDOW_HOURS = 72;
/** Icerik / ileti kaynakli (aliciya ait olmayan) geri donus alt turleri. */
export const CONTENT_BOUNCE_SUBTYPES = ['ContentRejected', 'MessageTooLarge', 'AttachmentRejected'] as const;
const CLEARED_TTL_DAYS = 30;
const DAY_SECONDS = 86_400;
const WRITE_ATTEMPTS = 3;

export type SuppressionReason = 'bounce' | 'complaint';

export type EmailSuppression = {
  PK: string;
  SK: string;
  entityType: 'EMAIL_SUPPRESSION';
  emailHash: string;
  emailMasked: string;
  reason: SuppressionReason;
  /** SES `bounceType`: Permanent | Transient | Undetermined. */
  bounceType?: string;
  bounceSubType?: string;
  /** SES `complaintFeedbackType` (abuse, fraud ...). */
  feedbackType?: string;
  feedbackId?: string;
  /** SES olay zamani (son olay). */
  at: string;
  recordedAt: string;
  /** `observing`: pencere icindeki gecici geri donusler sayiliyor, engel yok. */
  status: 'active' | 'cleared' | 'observing';
  /** Penceredeki gecici geri donuslerin kayit zamanlari. */
  softBounces?: string[];
  clearedAt?: string;
  clearedBy?: string;
  clearReason?: string;
  /** Gecici engel / izleme / kaldirilmis kayit: DynamoDB TTL (sn). */
  ttl?: number;
  version: number;
};

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const emailHash = (email: string) => createHash('sha256').update(normalizeEmail(email), 'utf8').digest('hex');
export const suppressionKey = (hash: string) => ({ PK: SUPPRESSION_PK, SK: `H#${hash}` });

/** `ahmet@ornek.com` -> `a***@ornek.com` (ekranda tanima icin; adresin tamami saklanmaz). */
export function maskEmail(email: string): string {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${e[0]}***${e.slice(at)}`;
}

/** Kayit bu an etkin engel mi? (TTL silmesi gecikebilir: sure kodda da kontrol edilir.) */
export function isActiveSuppression(s: Pick<EmailSuppression, 'status' | 'ttl'> | undefined, now: Date): boolean {
  if (!s || s.status !== 'active') return false;
  return s.ttl === undefined || s.ttl * 1000 > now.getTime();
}

const isHardActive = (s: EmailSuppression | undefined, now: Date) => !!s && isActiveSuppression(s, now) && s.ttl === undefined;

// ---------------------------------------------------------------------------
// SES geri bildirim ayristirma (saf)
// ---------------------------------------------------------------------------

export type FeedbackEntry = {
  email: string;
  reason: SuppressionReason;
  soft: boolean;
  bounceType?: string;
  bounceSubType?: string;
  feedbackType?: string;
  feedbackId?: string;
  at: string;
};

const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
const isAddress = (e: string | undefined): e is string => !!e && e.includes('@');
const recipients = (v: unknown) => (Array.isArray(v) ? v.map((r) => text(obj(r)?.emailAddress)).filter(isAddress) : []);

/** Tek alicili iletide `mail.destination` (iletilen postada Final-Recipient farkli olabilir). */
function withDestination(found: string[], mail: Record<string, unknown> | undefined): string[] {
  const dest = Array.isArray(mail?.destination) ? (mail.destination as unknown[]).map(text).filter(isAddress) : [];
  const out = [...found];
  if (dest.length === 1 && found.length > 0) {
    const d = dest[0] as string;
    if (!out.some((e) => normalizeEmail(e) === normalizeEmail(d))) out.push(d);
  }
  return out;
}

/**
 * SES bildirimi (kimlik bildirimi: `notificationType`; yapilandirma seti olay yayini: `eventType`).
 * Bounce / Complaint disindaki turler (Delivery, Send ...) ve icerik kaynakli geri donusler bos liste doner.
 */
export function parseSesFeedback(message: unknown, now: Date): FeedbackEntry[] {
  const m = obj(message);
  if (!m) return [];
  const type = text(m.notificationType) ?? text(m.eventType);
  const mail = obj(m.mail);
  if (type === 'Bounce') {
    const b = obj(m.bounce) ?? {};
    const bounceType = text(b.bounceType);
    const bounceSubType = text(b.bounceSubType);
    if (bounceSubType && (CONTENT_BOUNCE_SUBTYPES as readonly string[]).includes(bounceSubType)) return [];
    const soft = bounceType !== 'Permanent';
    return withDestination(recipients(b.bouncedRecipients), mail).map((email) => ({
      email,
      reason: 'bounce' as const,
      soft,
      ...(bounceType ? { bounceType } : {}),
      ...(bounceSubType ? { bounceSubType } : {}),
      ...(text(b.feedbackId) ? { feedbackId: text(b.feedbackId) } : {}),
      at: text(b.timestamp) ?? now.toISOString(),
    }));
  }
  if (type === 'Complaint') {
    const c = obj(m.complaint) ?? {};
    return withDestination(recipients(c.complainedRecipients), mail).map((email) => ({
      email,
      reason: 'complaint' as const,
      soft: false,
      ...(text(c.complaintFeedbackType) ? { feedbackType: text(c.complaintFeedbackType) } : {}),
      ...(text(c.feedbackId) ? { feedbackId: text(c.feedbackId) } : {}),
      at: text(c.timestamp) ?? now.toISOString(),
    }));
  }
  return [];
}

/**
 * Yeni geri bildirimden sonraki kayit (saf). `undefined`: yazim gerekmiyor (gecici geri donus
 * etkin kalici engelin yerine gecmez).
 */
export function nextSuppression(existing: EmailSuppression | undefined, e: FeedbackEntry, now: Date): EmailSuppression | undefined {
  const hash = emailHash(e.email);
  const at = now.toISOString();
  const nowSec = Math.floor(now.getTime() / 1000);
  const base = {
    ...suppressionKey(hash),
    entityType: 'EMAIL_SUPPRESSION' as const,
    emailHash: hash,
    emailMasked: maskEmail(e.email),
    reason: e.reason,
    ...(e.bounceType ? { bounceType: e.bounceType } : {}),
    ...(e.bounceSubType ? { bounceSubType: e.bounceSubType } : {}),
    ...(e.feedbackType ? { feedbackType: e.feedbackType } : {}),
    ...(e.feedbackId ? { feedbackId: e.feedbackId } : {}),
    at: e.at,
    recordedAt: at,
    version: (existing?.version ?? 0) + 1,
  };
  if (!e.soft) return { ...base, status: 'active' };
  if (isHardActive(existing, now)) return undefined;
  // Pencere: kaldirilmis kayittan sayilmaz; izlenen / gecici engelli kayittan surer.
  const since = now.getTime() - SOFT_BOUNCE_WINDOW_HOURS * 3600_000;
  const previous = existing && existing.status !== 'cleared' ? (existing.softBounces ?? []) : [];
  const softBounces = [...previous.filter((t) => Date.parse(t) >= since), at];
  const suppress = softBounces.length >= SOFT_BOUNCE_LIMIT || isActiveSuppression(existing, now);
  return suppress
    ? { ...base, status: 'active', softBounces, ttl: nowSec + SOFT_BOUNCE_DAYS * DAY_SECONDS }
    : { ...base, status: 'observing', softBounces, ttl: nowSec + SOFT_BOUNCE_WINDOW_HOURS * 3600 };
}

// ---------------------------------------------------------------------------
// Depo (tum yazimlar surum kosullu)
// ---------------------------------------------------------------------------

export type SuppressionStore = {
  get(hash: string): Promise<EmailSuppression | undefined>;
  /** `expectedVersion` null: kayit olmamali; degilse surum esit olmali. Tutmazsa `conflict`. */
  write(item: EmailSuppression, expectedVersion: number | null): Promise<void>;
  /** Kaldirma: denetimli, surum kosullu yazim (platform kapsami). */
  writeAudited(item: EmailSuppression, expectedVersion: number, audit: AuditDraft): Promise<void>;
  /** `activeOnly`: sorguda filtrelenir (etkin ve suresi dolmamis). */
  list(opts: { limit: number; cursor?: string; activeOnly: boolean; now: Date }): Promise<{ items: EmailSuppression[]; cursor?: string }>;
};

const encodeCursor = (key: Record<string, unknown>) => Buffer.from(JSON.stringify({ PK: key.PK, SK: key.SK }), 'utf8').toString('base64url');
function decodeCursor(cursor: string): Record<string, unknown> | undefined {
  try {
    const k = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { PK?: unknown; SK?: unknown };
    return k.PK === SUPPRESSION_PK && typeof k.SK === 'string' && k.SK.startsWith('H#') ? { PK: k.PK, SK: k.SK } : undefined;
  } catch {
    return undefined;
  }
}

export function createDynamoSuppressionStore(): SuppressionStore {
  return {
    async get(hash) {
      const { client, tableName } = getDynamo();
      try {
        const out = await client.send(new GetCommand({ TableName: tableName, Key: suppressionKey(hash), ConsistentRead: true }));
        return out.Item as EmailSuppression | undefined;
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    write: (item, expectedVersion) => (expectedVersion === null ? putNewItem(item) : putVersionedItem(item, expectedVersion)),
    writeAudited: (item, expectedVersion, audit) => auditedPutVersioned(item, expectedVersion, audit),
    async list({ limit, cursor, activeOnly, now }) {
      const { client, tableName } = getDynamo();
      const start = cursor ? decodeCursor(cursor) : undefined;
      try {
        const out = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
            ...(activeOnly
              ? {
                  FilterExpression: '#status = :active AND (attribute_not_exists(#ttl) OR #ttl > :now)',
                  ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
                  ExpressionAttributeValues: { ':pk': SUPPRESSION_PK, ':sk': 'H#', ':active': 'active', ':now': Math.floor(now.getTime() / 1000) },
                }
              : { ExpressionAttributeValues: { ':pk': SUPPRESSION_PK, ':sk': 'H#' } }),
            Limit: limit,
            ...(start ? { ExclusiveStartKey: start } : {}),
          }),
        );
        return { items: (out.Items ?? []) as EmailSuppression[], ...(out.LastEvaluatedKey ? { cursor: encodeCursor(out.LastEvaluatedKey) } : {}) };
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
  };
}

/** Bellek ici depo (testler): ayni surum kosulu semantigi. `beforeWrite`: yarisi taklit etmek icin. */
export function createMemorySuppressionStore() {
  const items = new Map<string, EmailSuppression>();
  const audits: AuditDraft[] = [];
  const hooks: { beforeWrite?: (item: EmailSuppression) => void } = {};
  const check = (item: EmailSuppression, expectedVersion: number | null) => {
    hooks.beforeWrite?.(item);
    const cur = items.get(item.emailHash);
    if (expectedVersion === null ? cur !== undefined : cur?.version !== expectedVersion) throw new DataAccessError('conflict', 'Kosul saglanmadi (surum catismasi)');
  };
  const store: SuppressionStore = {
    get: async (hash) => (items.has(hash) ? structuredClone(items.get(hash)) : undefined),
    write: async (item, expectedVersion) => {
      check(item, expectedVersion);
      items.set(item.emailHash, structuredClone(item));
    },
    writeAudited: async (item, expectedVersion, audit) => {
      check(item, expectedVersion);
      items.set(item.emailHash, structuredClone(item));
      audits.push(audit);
    },
    list: async ({ limit, cursor, activeOnly, now }) => {
      const all = [...items.values()].sort((a, b) => a.SK.localeCompare(b.SK));
      const from = cursor ? all.findIndex((i) => i.SK > cursor) : 0;
      const page = from < 0 ? [] : all.slice(from, from + limit);
      const last = page.at(-1);
      return {
        items: page.filter((i) => !activeOnly || isActiveSuppression(i, now)).map((i) => structuredClone(i)),
        ...(last && from + limit < all.length ? { cursor: last.SK } : {}),
      };
    },
  };
  return { store, items, audits, hooks };
}

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

export type SuppressionView = Pick<EmailSuppression, 'emailHash' | 'emailMasked' | 'reason' | 'bounceType' | 'bounceSubType' | 'feedbackType' | 'at' | 'recordedAt' | 'status' | 'clearedAt' | 'clearedBy' | 'clearReason'> & {
  /** Gecici engelin dusecegi an. */
  expiresAt?: string;
  /** Izlenen kayitta penceredeki gecici geri donus sayisi. */
  softBounceCount?: number;
  active: boolean;
};

export class SuppressionError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  constructor(code: 'not_found' | 'validation' | 'conflict', message: string) {
    super(message);
    this.name = 'SuppressionError';
    this.code = code;
    this.httpStatus = code === 'not_found' ? 404 : code === 'conflict' ? 409 : 400;
  }
}

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const HASH = /^[0-9a-f]{64}$/;
const isConflict = (err: unknown) => err instanceof DataAccessError && err.code === 'conflict';
/** Liste sayfasini doldurmak icin en fazla okunan DynamoDB sayfasi (bos sayfa + imlec donmesin). */
const MAX_LIST_PAGES = 10;

export function createSuppressionService(deps: { store: SuppressionStore; now?: () => Date; log?: Pick<Console, 'info'> }) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console;

  function view(s: EmailSuppression): SuppressionView {
    const { PK: _pk, SK: _sk, entityType: _e, ttl, feedbackId: _f, softBounces, version: _v, ...rest } = s;
    return {
      ...rest,
      ...(ttl !== undefined && s.status === 'active' ? { expiresAt: new Date(ttl * 1000).toISOString() } : {}),
      ...(s.status === 'observing' ? { softBounceCount: softBounces?.length ?? 0 } : {}),
      active: isActiveSuppression(s, now()),
    };
  }

  /** E-posta kanali: alici engelli mi? */
  async function isSuppressed(email: string): Promise<EmailSuppression | undefined> {
    const s = await deps.store.get(emailHash(email));
    return isActiveSuppression(s, now()) ? s : undefined;
  }

  /** SES geri bildirimi: alici basina surum kosullu oku-hesapla-yaz (cakismada yeniden okur). */
  async function record(entries: readonly FeedbackEntry[]): Promise<{ recorded: number; skipped: number }> {
    let recorded = 0;
    let skipped = 0;
    for (const e of entries) {
      const hash = emailHash(e.email);
      for (let attempt = 1; ; attempt++) {
        const existing = await deps.store.get(hash);
        const next = nextSuppression(existing, e, now());
        if (!next) {
          skipped++;
          break;
        }
        try {
          await deps.store.write(next, existing ? existing.version : null);
          recorded++;
          // Adres loga yazilmaz: yalnizca hash'in basi ve tur.
          log.info(JSON.stringify({ msg: 'email_suppression_recorded', emailHash: hash.slice(0, 12), reason: e.reason, bounceType: e.bounceType, soft: e.soft, status: next.status }));
          break;
        } catch (err) {
          if (!isConflict(err) || attempt >= WRITE_ATTEMPTS) throw err;
        }
      }
    }
    return { recorded, skipped };
  }

  async function list(q: { cursor?: string; limit?: number; status?: string }) {
    const limit = Math.min(Math.max(Number.isInteger(q.limit) ? (q.limit as number) : 50, 1), 100);
    const activeOnly = q.status !== 'all';
    const items: SuppressionView[] = [];
    let cursor = q.cursor;
    // Filtre sorguda; sayfa dolana veya kayit bitene kadar devam (bos sayfa + imlec donmez).
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const out = await deps.store.list({ limit: limit - items.length, activeOnly, now: now(), ...(cursor ? { cursor } : {}) });
      items.push(...out.items.map(view).filter((v) => !activeOnly || v.active));
      cursor = out.cursor;
      if (!cursor || items.length >= limit) break;
    }
    return { items, ...(cursor ? { cursor } : {}) };
  }

  /** Platform yoneticisi: e-postayla arama (adres istek govdesinde; URL'de degil). */
  async function lookup(body: unknown) {
    const email = typeof (body as { email?: unknown } | null)?.email === 'string' ? normalizeEmail((body as { email: string }).email) : '';
    if (!EMAIL.test(email) || email.length > 254) throw new SuppressionError('validation', 'Geçerli bir e-posta adresi girin');
    const s = await deps.store.get(emailHash(email));
    return { emailHash: emailHash(email), suppression: s ? view(s) : null };
  }

  async function clear(actorId: string, hash: string, body: unknown) {
    if (!HASH.test(hash)) throw new SuppressionError('validation', 'Geçersiz kayıt kimliği');
    const reason = typeof (body as { reason?: unknown } | null)?.reason === 'string' ? (body as { reason: string }).reason.trim() : '';
    if (reason.length < 5 || reason.length > 300) throw new SuppressionError('validation', 'Gerekçe 5-300 karakter olmalı');
    const s = await deps.store.get(hash);
    if (!s) throw new SuppressionError('not_found', 'E-posta engeli bulunamadı');
    if (!isActiveSuppression(s, now())) throw new SuppressionError('conflict', 'Bu engel zaten etkin değil');
    const at = now();
    const { softBounces: _s, ...rest } = s;
    const next: EmailSuppression = {
      ...rest,
      status: 'cleared',
      clearedAt: at.toISOString(),
      clearedBy: actorId,
      clearReason: reason,
      ttl: Math.floor(at.getTime() / 1000) + CLEARED_TTL_DAYS * DAY_SECONDS,
      version: s.version + 1,
    };
    try {
      await deps.store.writeAudited(next, s.version, {
        action: 'notification_suppression.clear',
        target: { type: 'email_suppression', id: hash },
        actorId,
        reason,
        details: { reason: s.reason, bounceType: s.bounceType, recordedAt: s.recordedAt },
      });
    } catch (err) {
      // Okumadan sonra yeni geri bildirim geldi (ornegin kalici geri donus): kaldirma onu silemez.
      if (isConflict(err)) throw new SuppressionError('conflict', 'Engel kaydı bu arada değişti; listeyi yenileyip tekrar deneyin');
      throw err;
    }
    return view(next);
  }

  return { isSuppressed, record, list, lookup, clear };
}

export type SuppressionService = ReturnType<typeof createSuppressionService>;

// ---------------------------------------------------------------------------
// SNS kaydi (bildirim worker'inin SNS girisi)
// ---------------------------------------------------------------------------

export type SnsLambdaRecord = { EventSource?: string; Sns?: { Message?: string; TopicArn?: string; MessageId?: string } };
export type SnsLambdaEvent = { Records: SnsLambdaRecord[] };

export const isSnsEvent = (event: unknown): event is SnsLambdaEvent =>
  Array.isArray((event as { Records?: unknown } | null)?.Records) && ((event as SnsLambdaEvent).Records[0]?.EventSource === 'aws:sns' || !!(event as SnsLambdaEvent).Records[0]?.Sns);

/**
 * SES geri bildirimlerini isler. Yalnizca beklenen topic'ten (`topicArn`; yapilandirilmamissa hicbiri:
 * kapali kalir) gelen kayitlar islenir. Bozuk mesaj atlanir (loglanir; tekrar denemek duzeltmez);
 * depo hatasi firlatilir (Lambda asenkron cagri yeniden dener, sonra DLQ).
 */
export async function handleSesFeedback(
  event: SnsLambdaEvent,
  deps: { service: Pick<SuppressionService, 'record'>; topicArn: string | undefined; now?: () => Date; log?: Pick<Console, 'info' | 'error'> },
) {
  const log = deps.log ?? console;
  const now = deps.now ?? (() => new Date());
  let recorded = 0;
  let skipped = 0;
  let ignored = 0;
  let foreign = 0;
  for (const r of event.Records) {
    if (!deps.topicArn || r.Sns?.TopicArn !== deps.topicArn) {
      foreign++;
      log.error(JSON.stringify({ msg: 'ses_feedback_foreign_topic', messageId: r.Sns?.MessageId, configured: !!deps.topicArn }));
      continue;
    }
    let message: unknown;
    try {
      message = JSON.parse(r.Sns?.Message ?? '');
    } catch {
      ignored++;
      log.error(JSON.stringify({ msg: 'ses_feedback_invalid', messageId: r.Sns?.MessageId }));
      continue;
    }
    const entries = parseSesFeedback(message, now());
    if (entries.length === 0) {
      ignored++;
      continue;
    }
    const out = await deps.service.record(entries);
    recorded += out.recorded;
    skipped += out.skipped;
  }
  log.info(JSON.stringify({ msg: 'ses_feedback_processed', records: event.Records.length, recorded, skipped, ignored, foreign }));
  return { recorded, skipped, ignored, foreign };
}
