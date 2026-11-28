import { createHash } from 'node:crypto';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamo, toDataAccessError } from '../../config/dynamodb.js';
import { type AuditDraft, auditedPut } from '../audit/log.js';

/**
 * Bildirim devami: SES geri donus (bounce) / sikayet (complaint) olaylarindan e-posta engeli.
 *
 * Akis (SES canliya alininca): SES kimliginin geri bildirim bildirimleri -> SNS `<yigin>-ses-feedback`
 * topic'i (infra/ses_feedback.tf) -> bildirim worker'i (SNS kaydi; `handleSesFeedback`) -> engel kaydi.
 * E-posta kanali (email.ts) engelli aliciya gondermez (`skipped: suppressed`, `email_suppressed` logu).
 *
 * Kayit (platform kapsami; e-posta apartmandan bagimsizdir):
 *   PK = `EMAILSUP`, SK = `H#<sha256(kucuk harf adres)>`
 *   Adresin kendisi saklanmaz: anahtar hash, ekranda yalnizca maskeli bicim (`a***@ornek.com`).
 *   Kalici geri donus ve sikayet sureksizdir (platform yoneticisi kaldirir); gecici / belirsiz
 *   geri donus `SOFT_BOUNCE_DAYS` gun sonra kendiliginden duser (`ttl`; okuma da sureyi kontrol eder).
 *   Kaldirma silme degildir: kayit `cleared` olur (denetimli), 30 gun sonra TTL ile duser.
 * Gecici geri donus, etkin kalici engeli zayiflatmaz. Ayni geri bildirimin tekrar teslimi ayni kaydi yazar.
 */

export const SUPPRESSION_PK = 'EMAILSUP';
export const SOFT_BOUNCE_DAYS = 7;
const CLEARED_TTL_DAYS = 30;
const DAY_SECONDS = 86_400;

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
  /** SES olay zamani. */
  at: string;
  recordedAt: string;
  status: 'active' | 'cleared';
  clearedAt?: string;
  clearedBy?: string;
  clearReason?: string;
  /** Gecici geri donus / kaldirilmis kayit: DynamoDB TTL (sn). */
  ttl?: number;
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

const isHard = (s: Pick<EmailSuppression, 'reason' | 'ttl'>) => s.ttl === undefined;

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
const recipients = (v: unknown) => (Array.isArray(v) ? v.map((r) => text(obj(r)?.emailAddress)).filter((e): e is string => !!e && e.includes('@')) : []);

/**
 * SES bildirimi (kimlik bildirimi: `notificationType`; yapilandirma seti olay yayini: `eventType`).
 * Bounce / Complaint disindaki turler (Delivery, Send ...) bos liste doner.
 */
export function parseSesFeedback(message: unknown, now: Date): FeedbackEntry[] {
  const m = obj(message);
  if (!m) return [];
  const type = text(m.notificationType) ?? text(m.eventType);
  if (type === 'Bounce') {
    const b = obj(m.bounce) ?? {};
    const bounceType = text(b.bounceType);
    const soft = bounceType !== 'Permanent';
    return recipients(b.bouncedRecipients).map((email) => ({
      email,
      reason: 'bounce' as const,
      soft,
      ...(bounceType ? { bounceType } : {}),
      ...(text(b.bounceSubType) ? { bounceSubType: text(b.bounceSubType) } : {}),
      ...(text(b.feedbackId) ? { feedbackId: text(b.feedbackId) } : {}),
      at: text(b.timestamp) ?? now.toISOString(),
    }));
  }
  if (type === 'Complaint') {
    const c = obj(m.complaint) ?? {};
    return recipients(c.complainedRecipients).map((email) => ({
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

// ---------------------------------------------------------------------------
// Depo
// ---------------------------------------------------------------------------

export type SuppressionStore = {
  get(hash: string): Promise<EmailSuppression | undefined>;
  put(item: EmailSuppression): Promise<void>;
  /** Kaldirma: denetimli yazim (platform kapsami). */
  putAudited(item: EmailSuppression, audit: AuditDraft): Promise<void>;
  list(opts: { limit: number; cursor?: string }): Promise<{ items: EmailSuppression[]; cursor?: string }>;
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
        const out = await client.send(new GetCommand({ TableName: tableName, Key: suppressionKey(hash) }));
        return out.Item as EmailSuppression | undefined;
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    async put(item) {
      const { client, tableName } = getDynamo();
      try {
        await client.send(new PutCommand({ TableName: tableName, Item: item }));
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    putAudited: (item, audit) => auditedPut(item, audit),
    async list({ limit, cursor }) {
      const { client, tableName } = getDynamo();
      const start = cursor ? decodeCursor(cursor) : undefined;
      try {
        const out = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
            ExpressionAttributeValues: { ':pk': SUPPRESSION_PK, ':sk': 'H#' },
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

/** Bellek ici depo (testler). */
export function createMemorySuppressionStore() {
  const items = new Map<string, EmailSuppression>();
  const audits: AuditDraft[] = [];
  const store: SuppressionStore = {
    get: async (hash) => (items.has(hash) ? structuredClone(items.get(hash)) : undefined),
    put: async (item) => void items.set(item.emailHash, structuredClone(item)),
    putAudited: async (item, audit) => {
      items.set(item.emailHash, structuredClone(item));
      audits.push(audit);
    },
    list: async ({ limit, cursor }) => {
      const all = [...items.values()].sort((a, b) => a.SK.localeCompare(b.SK));
      const from = cursor ? all.findIndex((i) => i.SK > cursor) : 0;
      const page = from < 0 ? [] : all.slice(from, from + limit);
      const last = page.at(-1);
      return { items: page.map((i) => structuredClone(i)), ...(last && from + limit < all.length ? { cursor: last.SK } : {}) };
    },
  };
  return { store, items, audits };
}

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

export type SuppressionView = Pick<EmailSuppression, 'emailHash' | 'emailMasked' | 'reason' | 'bounceType' | 'bounceSubType' | 'feedbackType' | 'at' | 'recordedAt' | 'status' | 'clearedAt' | 'clearedBy' | 'clearReason'> & {
  /** Gecici geri donusun dusecegi an. */
  expiresAt?: string;
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

export function createSuppressionService(deps: { store: SuppressionStore; now?: () => Date; log?: Pick<Console, 'info'> }) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console;

  function view(s: EmailSuppression): SuppressionView {
    const { PK: _pk, SK: _sk, entityType: _e, ttl, feedbackId: _f, ...rest } = s;
    return { ...rest, ...(ttl !== undefined && s.status === 'active' ? { expiresAt: new Date(ttl * 1000).toISOString() } : {}), active: isActiveSuppression(s, now()) };
  }

  /** E-posta kanali: alici engelli mi? */
  async function isSuppressed(email: string): Promise<EmailSuppression | undefined> {
    const s = await deps.store.get(emailHash(email));
    return isActiveSuppression(s, now()) ? s : undefined;
  }

  /** SES geri bildirimi: alici basina engel (gecici geri donus kalici engeli zayiflatmaz). */
  async function record(entries: readonly FeedbackEntry[]): Promise<{ recorded: number; skipped: number }> {
    let recorded = 0;
    let skipped = 0;
    for (const e of entries) {
      const hash = emailHash(e.email);
      const existing = await deps.store.get(hash);
      if (e.soft && existing && isActiveSuppression(existing, now()) && isHard(existing)) {
        skipped++;
        continue;
      }
      const at = now();
      const item: EmailSuppression = {
        ...suppressionKey(hash),
        entityType: 'EMAIL_SUPPRESSION',
        emailHash: hash,
        emailMasked: maskEmail(e.email),
        reason: e.reason,
        ...(e.bounceType ? { bounceType: e.bounceType } : {}),
        ...(e.bounceSubType ? { bounceSubType: e.bounceSubType } : {}),
        ...(e.feedbackType ? { feedbackType: e.feedbackType } : {}),
        ...(e.feedbackId ? { feedbackId: e.feedbackId } : {}),
        at: e.at,
        recordedAt: at.toISOString(),
        status: 'active',
        ...(e.soft ? { ttl: Math.floor(at.getTime() / 1000) + SOFT_BOUNCE_DAYS * DAY_SECONDS } : {}),
      };
      await deps.store.put(item);
      recorded++;
      // Adres loga yazilmaz: yalnizca hash'in basi ve tur.
      log.info(JSON.stringify({ msg: 'email_suppression_recorded', emailHash: hash.slice(0, 12), reason: e.reason, bounceType: e.bounceType, soft: e.soft }));
    }
    return { recorded, skipped };
  }

  async function list(q: { cursor?: string; limit?: number; status?: string }) {
    const limit = Math.min(Math.max(Number.isInteger(q.limit) ? (q.limit as number) : 50, 1), 100);
    const page = await deps.store.list({ limit, ...(q.cursor ? { cursor: q.cursor } : {}) });
    const all = q.status === 'all';
    return { items: page.items.map(view).filter((v) => all || v.active), ...(page.cursor ? { cursor: page.cursor } : {}) };
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
    const next: EmailSuppression = {
      ...s,
      status: 'cleared',
      clearedAt: at.toISOString(),
      clearedBy: actorId,
      clearReason: reason,
      ttl: Math.floor(at.getTime() / 1000) + CLEARED_TTL_DAYS * DAY_SECONDS,
    };
    await deps.store.putAudited(next, {
      action: 'notification_suppression.clear',
      target: { type: 'email_suppression', id: hash },
      actorId,
      reason,
      details: { reason: s.reason, bounceType: s.bounceType, recordedAt: s.recordedAt },
    });
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
 * SES geri bildirimlerini isler. Bozuk mesaj atlanir (loglanir; tekrar denemek duzeltmez); depo hatasi
 * firlatilir (Lambda asenkron cagri yeniden dener).
 */
export async function handleSesFeedback(event: SnsLambdaEvent, deps: { service: Pick<SuppressionService, 'record'>; now?: () => Date; log?: Pick<Console, 'info' | 'error'> }) {
  const log = deps.log ?? console;
  const now = deps.now ?? (() => new Date());
  let recorded = 0;
  let skipped = 0;
  let ignored = 0;
  for (const r of event.Records) {
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
  log.info(JSON.stringify({ msg: 'ses_feedback_processed', records: event.Records.length, recorded, skipped, ignored }));
  return { recorded, skipped, ignored };
}
