import { createHash, randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  type DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { DataAccessError, getDynamo, putNewItem, putVersionedItem, toDataAccessError } from '../../config/dynamodb.js';
import { getRequestContext } from './context.js';

/**
 * Degistirilemez denetim gunlugu (G1).
 *
 * Kayitlar ayri tabloda (`AUDIT_TABLE_NAME`), kapsam basina sira numarali ve hash zincirli:
 *   PK = `APT#<apartmentId>` | `PLATFORM`,  SK = `SEQ#<12 hane>`
 *   hash = sha256(prevHash + "\n" + kanonik JSON(kayit - hash))
 * Ayri bir "bas" kaydi yoktur: yazar son kaydi okur ve `SEQ#<n+1>`'i `attribute_not_exists`
 * kosuluyla ekler. Ayni anda yazan ikinci istek bu kosulda reddedilir ve son kaydi yeniden
 * okuyup tekrar dener. Bu sayede uygulama rolleri yalnizca PutItem/GetItem/Query ile calisir.
 *
 * Denetim kaydi, hassas yazimla AYNI `TransactWriteItems` icindedir (cok tablolu
 * transaction): yazim yoksa kayit yoktur, kayit yazilamazsa yazim da yoktur.
 *
 * Yapilandirma: production/Lambda'da `AUDIT_TABLE_NAME` yoksa hassas yazim reddedilir
 * (fail closed). Yerel gelistirme ve testlerde denetim atlanir (bir kez uyari).
 */

export const GENESIS_HASH = '0'.repeat(64);
export const AUDIT_RETENTION_YEARS = 10;
const SEQ_DIGITS = 12;
const MAX_CHAIN_ATTEMPTS = 8;

/**
 * Cekisme sonrasi bekleme: ustel artan pencere + tam jitter (eszamanli yazicilar ayni anda tekrar
 * denemesin). 1. deneme ~10-50 ms, 7. deneme en fazla ~1 sn.
 */
export function contentionBackoffMs(attempt: number, random: () => number = Math.random): number {
  const window = Math.min(1000, 20 * 2 ** Math.max(0, attempt));
  return 10 + Math.floor(random() * window);
}
const DETAILS_MAX_BYTES = 4000;

export type AuditTarget = { type: string; id: string };

/** Hassas yazimin denetim tarifi (aktor ve istek bilgisi baglamdan gelir). */
export type AuditDraft = {
  /** Verilirse kapsam `APT#<id>`; verilmezse `PLATFORM` (kullanici/platform islemleri). */
  apartmentId?: string;
  action: string;
  target: AuditTarget;
  /** Istek baglami yoksa (zamanlayici/worker) aktor kimligi. */
  actorId?: string;
  reason?: string;
  details?: Record<string, unknown>;
};

export type AuditEntry = {
  PK: string;
  SK: string;
  entityType: 'AUDIT_ENTRY';
  scope: string;
  seq: number;
  auditId: string;
  at: string;
  action: string;
  actor: { userId: string; role: string; supportSessionId?: string };
  apartmentId?: string;
  target: AuditTarget;
  reason?: string;
  details?: Record<string, unknown>;
  request?: { requestId: string; ip?: string; userAgent?: string };
  prevHash: string;
  hash: string;
  ttl: number;
  GSI1PK: string;
  GSI1SK: string;
};

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

// ---------------------------------------------------------------------------
// Anahtarlar, kanonik bicim, hash
// ---------------------------------------------------------------------------

export const PLATFORM_SCOPE = 'PLATFORM';

export const auditScope = (apartmentId?: string) => (apartmentId ? `APT#${apartmentId}` : PLATFORM_SCOPE);

export const seqKey = (seq: number) => `SEQ#${String(seq).padStart(SEQ_DIGITS, '0')}`;

/** Anahtarlari sirali, `undefined` alanlari atilmis JSON (hash girdisi). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** Zincire giren alanlar: GSI anahtarlari ve hash'in kendisi haric. */
export function hashedPart(entry: Omit<AuditEntry, 'hash'> | AuditEntry): Record<string, unknown> {
  const { hash: _h, GSI1PK: _p, GSI1SK: _s, ...rest } = entry as AuditEntry;
  return rest;
}

export function computeHash(prevHash: string, entry: Omit<AuditEntry, 'hash'> | AuditEntry): string {
  return createHash('sha256').update(`${prevHash}\n${canonicalJson(hashedPart(entry))}`).digest('hex');
}

// ---------------------------------------------------------------------------
// Ayrinti maskeleme
// ---------------------------------------------------------------------------

const SENSITIVE_KEY = /e-?mail|phone|telefon|tckn|identity|password|secret|token|iban|card|kart/i;

/** Kisisel/gizli alanlari maskeler, metinleri ve dizileri kisaltir, boyutu sinirlar. */
export function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v ?? undefined;
    if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 300)}…` : v;
    if (typeof v !== 'object') return v;
    if (depth > 4) return '[derin]';
    if (Array.isArray(v)) {
      const head = v.slice(0, 50).map((x) => walk(x, depth + 1));
      return v.length > 50 ? [...head, `…(+${v.length - 50})`] : head;
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      // Boolean bayraklar (emailEnabled gibi) kisisel veri tasimaz; yalnizca deger maskelenir.
      out[k] = SENSITIVE_KEY.test(k) && x !== undefined && x !== null && typeof x !== 'boolean' ? '[maskeli]' : walk(x, depth + 1);
    }
    return out;
  };
  const clean = walk(details, 0) as Record<string, unknown>;
  const size = Buffer.byteLength(JSON.stringify(clean), 'utf8');
  return size > DETAILS_MAX_BYTES ? { truncated: true, keys: Object.keys(clean).slice(0, 30) } : clean;
}

// ---------------------------------------------------------------------------
// Yapilandirma
// ---------------------------------------------------------------------------

let warned = false;

/** Denetim tablosu; `undefined`: yerel/test ortaminda denetim kapali. */
export function auditTable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const table = env.AUDIT_TABLE_NAME;
  if (table) return table;
  const isProd = env.NODE_ENV === 'production' || Boolean(env.AWS_LAMBDA_FUNCTION_NAME);
  if (isProd) throw new DataAccessError('internal', 'Denetim gunlugu yapilandirilmamis (AUDIT_TABLE_NAME)');
  if (!warned && env.VITEST === undefined) {
    warned = true;
    console.warn('AUDIT_TABLE_NAME tanimsiz: denetim kayitlari yazilmiyor (yalnizca yerel gelistirme).');
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Kayit uretimi
// ---------------------------------------------------------------------------

export type ChainTail = { seq: number; hash: string };

export async function readTail(client: DynamoDBDocumentClient, table: string, scope: string): Promise<ChainTail> {
  const out = await client.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :seq)',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
      ExpressionAttributeValues: { ':pk': scope, ':seq': 'SEQ#' },
      ScanIndexForward: false,
      Limit: 1,
      ConsistentRead: true,
    }),
  );
  const last = out?.Items?.[0] as Pick<AuditEntry, 'seq' | 'hash'> | undefined;
  return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS_HASH };
}

export function buildEntry(draft: AuditDraft, tail: ChainTail, now: Date = new Date()): AuditEntry {
  const ctx = getRequestContext();
  const scope = auditScope(draft.apartmentId);
  const seq = tail.seq + 1;
  const at = now.toISOString();
  const actor = ctx?.actor
    ? { userId: ctx.actor.userId, role: ctx.actor.role, ...(ctx.actor.supportSessionId ? { supportSessionId: ctx.actor.supportSessionId } : {}) }
    : { userId: draft.actorId ?? 'system', role: 'system' };
  const auditId = randomUUID();
  const base: Omit<AuditEntry, 'hash'> = {
    PK: scope,
    SK: seqKey(seq),
    entityType: 'AUDIT_ENTRY',
    scope,
    seq,
    auditId,
    at,
    action: draft.action,
    actor,
    ...(draft.apartmentId ? { apartmentId: draft.apartmentId } : {}),
    target: { type: draft.target.type, id: draft.target.id },
    ...(draft.reason ? { reason: draft.reason.slice(0, 500) } : {}),
    ...(draft.details ? { details: sanitizeDetails(draft.details) } : {}),
    ...(ctx
      ? {
          request: {
            requestId: ctx.requestId,
            ...(ctx.ip ? { ip: ctx.ip } : {}),
            ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
          },
        }
      : {}),
    prevHash: tail.hash,
    ttl: Math.floor(now.getTime() / 1000) + AUDIT_RETENTION_YEARS * 365 * 86_400 + Math.floor(AUDIT_RETENTION_YEARS / 4) * 86_400,
    GSI1PK: `ACTOR#${actor.userId}`,
    GSI1SK: `${at}#${scope}#${seqKey(seq)}`,
  };
  return { ...base, hash: computeHash(tail.hash, base) };
}

const auditPut = (table: string, entry: AuditEntry): TransactItem => ({
  Put: { TableName: table, Item: entry, ConditionExpression: 'attribute_not_exists(PK)' },
});

export class AuditChainBusyError extends DataAccessError {
  constructor() {
    super('throttled', 'Denetim gunlugu yogun; islem tekrar denenmeli');
    this.name = 'AuditChainBusyError';
  }
}

/** Yalnizca denetim kaydinin kosulu/cakismasi yuzunden mi iptal edildi? */
/**
 * Iptal yalnizca CEKISMEDEN mi? Gecici sayilan nedenler: herhangi bir ogede `TransactionConflict`
 * (sicak gelir hesabi, donem kilidi `ConditionCheck`'i gibi ayni anda baska islemin dokundugu
 * ogeler) ve denetim kaydinin (`firstAuditIndex` ve sonrasi) zincir yarisi
 * (`ConditionalCheckFailed`: ayni sira numarasini baska yazim aldi). Veri ogelerinde
 * `ConditionalCheckFailed` (idempotency, surum, kapama kilidi...) is kuralidir: tekrar denenmez.
 *
 * Toplu tahakkukta eszamanli kalemler ayni anda gelir hesabina, kilit kaydina ve denetim zincirine
 * dokundugu icin iptal nedenleri KARISIK gelir (or. `...,TransactionConflict,None,TransactionConflict,
 * ConditionalCheckFailed`); eski kontrol yalnizca "tek basina denetim cakismasi"ni tekrar deniyordu.
 * Iptal edilen islem hicbir ogeyi yazmaz: tekrar denemek guvenlidir.
 */
export function contentionOnly(err: unknown, firstAuditIndex: number): boolean {
  if (!(err instanceof TransactionCanceledException)) return false;
  const reasons = err.CancellationReasons ?? [];
  const failed = reasons.map((r, i) => ({ i, code: r.Code })).filter((r) => r.code && r.code !== 'None');
  return (
    failed.length > 0 &&
    failed.every((r) => r.code === 'TransactionConflict' || (r.i >= firstAuditIndex && r.code === 'ConditionalCheckFailed'))
  );
}

/**
 * `items` + denetim kaydini tek `TransactWriteItems` ile yazar. Denetim kapaliysa yalnizca
 * `items` yazilir. Zincir yarisinda (ayni sira baska istekce alindi) son kayit yeniden okunur.
 * Diger iptal nedenleri oldugu gibi firlatilir: denetim kaydi her zaman SON ogedir, cagiranin
 * oge indeksleri degismez.
 */
export async function sendWithAudit(
  client: DynamoDBDocumentClient,
  items: TransactItem[],
  draft: AuditDraft | undefined,
  now: () => Date = () => new Date(),
): Promise<AuditEntry | undefined> {
  const table = draft ? auditTable() : undefined;
  if (!draft || !table) {
    await client.send(new TransactWriteCommand({ TransactItems: items }));
    return undefined;
  }
  if (items.length + 1 > 100) throw new Error('Atomik yazim 100 ogeyi asamaz (denetim kaydi dahil)');
  const scope = auditScope(draft.apartmentId);
  for (let attempt = 1; attempt <= MAX_CHAIN_ATTEMPTS; attempt++) {
    const tail = await readTail(client, table, scope);
    const entry = buildEntry(draft, tail, now());
    try {
      await client.send(new TransactWriteCommand({ TransactItems: [...items, auditPut(table, entry)] }));
      return entry;
    } catch (err) {
      if (!contentionOnly(err, items.length) || attempt === MAX_CHAIN_ATTEMPTS) {
        if (contentionOnly(err, items.length)) throw new AuditChainBusyError();
        throw err;
      }
      await new Promise((r) => setTimeout(r, contentionBackoffMs(attempt)));
    }
  }
  throw new AuditChainBusyError();
}

/**
 * `items` + birden fazla denetim kaydini (ayni kapsam, ardisik sira) tek `TransactWriteItems` ile
 * yazar. Kayitlar zincirde arka arkaya baglanir (ikincinin `prevHash`'i birincinin hash'i). Tum
 * taslaklar ayni apartman kapsaminda olmalidir. Denetim kapaliysa yalnizca `items` yazilir.
 */
export async function sendWithAudits(
  client: DynamoDBDocumentClient,
  items: TransactItem[],
  drafts: readonly AuditDraft[],
  now: () => Date = () => new Date(),
): Promise<AuditEntry[]> {
  const table = drafts.length ? auditTable() : undefined;
  if (!table) {
    await client.send(new TransactWriteCommand({ TransactItems: items }));
    return [];
  }
  if (drafts.length === 1) {
    const one = await sendWithAudit(client, items, drafts[0], now);
    return one ? [one] : [];
  }
  const scope = auditScope(drafts[0]?.apartmentId);
  if (drafts.some((d) => auditScope(d.apartmentId) !== scope)) throw new Error('Denetim kayitlari ayni kapsamda olmali');
  if (items.length + drafts.length > 100) throw new Error('Atomik yazim 100 ogeyi asamaz (denetim kayitlari dahil)');
  for (let attempt = 1; attempt <= MAX_CHAIN_ATTEMPTS; attempt++) {
    let tail = await readTail(client, table, scope);
    const at = now();
    const entries: AuditEntry[] = [];
    for (const d of drafts) {
      const entry = buildEntry(d, tail, at);
      entries.push(entry);
      tail = { seq: entry.seq, hash: entry.hash };
    }
    try {
      await client.send(new TransactWriteCommand({ TransactItems: [...items, ...entries.map((e) => auditPut(table, e))] }));
      return entries;
    } catch (err) {
      if (!contentionOnly(err, items.length) || attempt === MAX_CHAIN_ATTEMPTS) {
        if (contentionOnly(err, items.length)) throw new AuditChainBusyError();
        throw err;
      }
      await new Promise((r) => setTimeout(r, contentionBackoffMs(attempt)));
    }
  }
  throw new AuditChainBusyError();
}

/** `putNewItem` + denetim kaydi (atomik). Kayit varsa `DataAccessError('conflict')`. */
export async function auditedPutNew(item: { PK: string; SK: string; [key: string]: unknown }, draft: AuditDraft): Promise<void> {
  if (!auditTable()) return putNewItem(item);
  const { client, tableName } = getDynamo();
  try {
    await sendWithAudit(client, [{ Put: { TableName: tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } }], draft);
  } catch (err) {
    throw mapSingleItem(err);
  }
}

/** `putVersionedItem` + denetim kaydi (atomik). Surum uyusmazsa `DataAccessError('conflict')`. */
export async function auditedPutVersioned(
  item: { PK: string; SK: string; [key: string]: unknown },
  expectedVersion: number,
  draft: AuditDraft,
): Promise<void> {
  if (!auditTable()) return putVersionedItem(item, expectedVersion);
  const { client, tableName } = getDynamo();
  try {
    await sendWithAudit(
      client,
      [
        {
          Put: {
            TableName: tableName,
            Item: item,
            ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':expectedVersion': expectedVersion },
          },
        },
      ],
      draft,
    );
  } catch (err) {
    throw mapSingleItem(err);
  }
}

/** Kosulsuz ustune yazim (ornegin kullanici tercihi) + denetim kaydi. */
export async function auditedPut(item: { PK: string; SK: string; [key: string]: unknown }, draft: AuditDraft): Promise<void> {
  const { client, tableName } = getDynamo();
  try {
    if (!auditTable()) await client.send(new PutCommand({ TableName: tableName, Item: item }));
    else await sendWithAudit(client, [{ Put: { TableName: tableName, Item: item } }], draft);
  } catch (err) {
    throw toDataAccessError(err);
  }
}

/**
 * Yalnizca denetim kaydi (ana tabloda karsiligi olmayan olay; ornegin destek oturumunda
 * yapilan istek). Denetim kapaliysa (yerel) yazilmaz.
 */
export async function appendAudit(draft: AuditDraft): Promise<AuditEntry | undefined> {
  if (!auditTable()) return undefined;
  const { client } = getDynamo();
  try {
    return await sendWithAudit(client, [], draft);
  } catch (err) {
    throw toDataAccessError(err);
  }
}

function mapSingleItem(err: unknown): DataAccessError {
  if (err instanceof TransactionCanceledException && err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
    return new DataAccessError('conflict', 'Kosul saglanmadi (kayit mevcut veya surum catismasi)', { cause: err });
  }
  return toDataAccessError(err);
}

// ---------------------------------------------------------------------------
// Zincir dogrulamasi (saf)
// ---------------------------------------------------------------------------

export type ChainFinding = {
  code: 'audit_chain_hash_mismatch' | 'audit_chain_link_broken' | 'audit_chain_gap' | 'audit_checkpoint_mismatch';
  scope: string;
  seq: number;
  detail?: string;
};

/**
 * Artan sirali kayitlari dogrular. `start` (kontrol noktasi): onceki dogrulanmis son kayit;
 * verilmezse ilk kayit seq=1 ise GENESIS'e baglanmali, degilse (TTL ile silinmis eski kayitlar)
 * oldugu gibi kabul edilir.
 */
export function verifyChain(scope: string, entries: readonly AuditEntry[], start?: ChainTail): { findings: ChainFinding[]; last?: ChainTail } {
  const findings: ChainFinding[] = [];
  let prev: ChainTail | undefined = start;
  for (const e of entries) {
    if (computeHash(e.prevHash, e) !== e.hash) {
      findings.push({ code: 'audit_chain_hash_mismatch', scope, seq: e.seq });
    }
    if (prev) {
      if (e.seq !== prev.seq + 1) findings.push({ code: 'audit_chain_gap', scope, seq: e.seq, detail: `beklenen ${prev.seq + 1}` });
      else if (e.prevHash !== prev.hash) findings.push({ code: 'audit_chain_link_broken', scope, seq: e.seq });
    } else if (e.seq === 1 && e.prevHash !== GENESIS_HASH) {
      findings.push({ code: 'audit_chain_link_broken', scope, seq: e.seq, detail: 'genesis' });
    }
    prev = { seq: e.seq, hash: e.hash };
  }
  return { findings, ...(prev ? { last: prev } : {}) };
}
