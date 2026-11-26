import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  type BatchGetCommandOutput,
  PutCommand,
  QueryCommand,
  type QueryCommandOutput,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  getDynamo,
  getTenantItem,
  queryTenantAll,
  KEY_SEPARATOR,
  skKey,
  tenantPk,
  toDataAccessError,
} from '../../config/dynamodb.js';
import { toOutboxItems } from '../../events/outbox.js';
import { PeriodClosedError, earliestDate, periodKeys } from './periodLock.js';
import { type AuditDraft, sendWithAudit } from '../audit/log.js';
import type { DomainEvent } from '../../events/publisher.js';
import type { IsoDate, TableKeys } from '../core/types.js';
import type {
  Account,
  Expense,
  IdempotencyRecord,
  LedgerEntry,
  Payment,
  Transaction,
} from './types.js';

export const financeKeys = {
  account: (apartmentId: string, accountId: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('ACCT', accountId),
  }),
  transaction: (apartmentId: string, transactionId: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('TX', transactionId),
  }),
  entry: (apartmentId: string, accountId: string, transactionId: string, lineNo: number): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('LE', accountId, transactionId, String(lineNo)),
  }),
  payment: (apartmentId: string, paymentId: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('PAY', paymentId),
  }),
  expense: (apartmentId: string, expenseId: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('EXP', expenseId),
  }),
  /**
   * Gider tarih dizini (GSI1): `GSI1PK = EXPDATE#<apartmentId>`, `GSI1SK = <YYYY-MM-DD>#<expenseId>`.
   * Gider kimligi rastgele oldugundan ana tabloda tarih sirasi yoktur; secici listeler ("en yeni
   * 200 gider") tum giderleri okumak yerine bu dizinden sinirli sorgu yapar.
   */
  expenseIndex: (apartmentId: string, date: string, expenseId: string) => ({
    GSI1PK: `EXPDATE${KEY_SEPARATOR}${apartmentId}`,
    GSI1SK: `${date}${KEY_SEPARATOR}${expenseId}`,
  }),
  counter: (apartmentId: string, name: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('CTR', name),
  }),
  idempotency: (apartmentId: string, id: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('IDEM', id),
  }),
};

const ACCOUNT_PREFIX = 'ACCT#';
const MAX_LINES = 20;
const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Defter cakisma hatasi
// ---------------------------------------------------------------------------

/**
 * precondition: `replaceRecords` icindeki bir belgenin surumu degismis (ornegin odeme niyeti
 * baska bir istekle sonuclandirilmis). `label` hangi belge oldugunu soyler.
 */
/**
 * closed: hesap `closedThrough` tarihine kadar kapatilmis (cari kapama); o tarih ve oncesine
 * kayit yazilamaz. `label` hesap kimligidir.
 */
export type LedgerConflictReason = 'duplicate' | 'version' | 'counter' | 'account_missing' | 'precondition' | 'closed';

/** Beklenen, servis katmaninin ele alacagi yazim cakismalari. */
export class LedgerConflictError extends Error {
  readonly reason: LedgerConflictReason;
  readonly label?: string;
  /** reason=closed: hesabin kapatildigi tarih. */
  readonly closedThrough?: string;

  constructor(reason: LedgerConflictReason, message = `Defter cakismasi: ${reason}`, label?: string, closedThrough?: string) {
    super(message);
    this.name = 'LedgerConflictError';
    this.reason = reason;
    this.label = label;
    this.closedThrough = closedThrough;
  }
}

// ---------------------------------------------------------------------------
// Atomik cift tarafli yazim
// ---------------------------------------------------------------------------

export type PostInput = {
  transaction: Transaction;
  idempotency: { id: string; fingerprint: string; recordId?: string };
  /** Bakiyeye bagli kurallar icin: hesap surumu degistiyse yazim reddedilir. */
  expectedVersions?: Record<string, number>;
  /** Ardisik numara (makbuz): `expected` okunan deger; es zamanli kullanimda cakisir. */
  counter?: { name: string; expected: number };
  /** Islemle ayni atomik yazimda saklanacak belge (Payment / Expense). */
  record?: Payment | Expense;
  /** Transactional outbox: islemle ayni atomik yazimda saklanacak domain olaylari. */
  outbox?: DomainEvent[];
  /** Denetim kaydi tarifi; verilmezse islemlerden turetilir (`ledgerAuditDraft`). */
  audit?: AuditDraft;
};

/** Surumlu belge (ornegin odeme niyeti): yalnizca mevcut surum `expectedVersion` ise yazilir. */
export type ReplaceRecord = {
  item: TableKeys & { version: number };
  expectedVersion: number;
  /** Cakismada `LedgerConflictError.label` olarak doner. */
  label: string;
};

/**
 * Birden fazla islemin TEK atomik yazimi (online odeme: gecikme tazminati kesinlestirmesi +
 * alt cari basina tahsilat + makbuzlar + odeme niyeti durum gecisi).
 */
export type PostBatchInput = {
  transactions: Transaction[];
  idempotency: {
    id: string;
    fingerprint: string;
    recordId?: string;
    transactionIds?: string[];
    recordIds?: string[];
  };
  expectedVersions?: Record<string, number>;
  /** `increment` kadar ardisik numara ayrilir (varsayilan 1). */
  counter?: { name: string; expected: number; increment?: number };
  records?: (Payment | Expense)[];
  replaceRecords?: ReplaceRecord[];
  /** Yeni belgeler (ornegin cari kapama kaydi): yalnizca yoksa yazilir. */
  newDocs?: (TableKeys & { entityType: string })[];
  /**
   * Hesap alanlari (cari kapama kilidi). `closedThrough: null` alani kaldirir. `bypassLock`:
   * bu yazimda o hesabin kilit kosulu uygulanmaz (yalnizca kapamanin geri alinmasi).
   */
  accountPatches?: Record<string, { closedThrough: IsoDate | null; bypassLock?: boolean }>;
  /**
   * Transactional outbox: bu yazimla AYNI atomik islemde `OUTBOX#<eventId>` kaydi olarak
   * saklanacak domain olaylari (bkz. `events/outbox.ts`). Yazim basarisizsa olay da yoktur.
   */
  outbox?: DomainEvent[];
  /**
   * Denetim kaydi (ayri tablo, ayni atomik yazim). Verilmezse islemlerden turetilir: her defter
   * yazimi (tahakkuk, tahsilat, gider, ters kayit, tazminat, online tahsilat...) denetlenir.
   */
  audit?: AuditDraft;
};

/** Islemlerden denetim tarifi: tur, tutar, referans ve kayit kimlikleri (kisisel veri yok). */
export function ledgerAuditDraft(input: PostBatchInput, apartmentId: string): AuditDraft {
  const txs = input.transactions;
  const first = txs[0];
  const kinds = [...new Set(txs.map((t) => t.kind))];
  const anchor = first?.transactionId ?? input.newDocs?.[0]?.SK ?? input.replaceRecords?.[0]?.label ?? 'document';
  return {
    apartmentId,
    action: kinds.length ? `ledger.${kinds.join('+')}` : 'ledger.document',
    target: { type: first ? 'transaction' : 'document', id: anchor },
    actorId: first?.createdBy,
    reason: first?.reason ?? first?.description,
    details: {
      transactions: txs.map((t) => ({
        id: t.transactionId,
        kind: t.kind,
        date: t.date,
        total: t.totalAmount,
        ...(t.reference ? { reference: t.reference } : {}),
        ...(t.reversalOf ? { reversalOf: t.reversalOf } : {}),
        ...(t.batchId ? { batchId: t.batchId } : {}),
        accounts: [...new Set(t.lines.map((l) => l.accountId))],
      })),
      ...(input.records?.length ? { records: input.records.map((r) => r.SK) } : {}),
      ...(input.newDocs?.length ? { documents: input.newDocs.map((d) => d.SK) } : {}),
      ...(input.accountPatches ? { accountPatches: input.accountPatches } : {}),
    },
  };
}

/** DynamoDB TransactWriteItems ust siniri. */
export const MAX_TRANSACT_ITEMS = 100;

/** Transaction satirlarindan degismez defter kayitlarini turetir. */
export function toLedgerEntries(tx: Transaction): LedgerEntry[] {
  return tx.lines.map((line, i) => ({
    ...financeKeys.entry(tx.siteId, line.accountId, tx.transactionId, i + 1),
    entityType: 'LEDGER_ENTRY' as const,
    entryId: `${tx.transactionId}:${i + 1}`,
    transactionId: tx.transactionId,
    siteId: tx.siteId,
    accountId: line.accountId,
    side: line.side,
    amount: line.amount,
    date: tx.date,
    lineNo: i + 1,
    unitId: line.unitId,
    liableParty: line.liableParty,
    createdAt: tx.createdAt,
    createdBy: tx.createdBy,
  }));
}

/** Programlama hatalarini DynamoDB'ye gitmeden yakalar. */
function assertBalanced(tx: Transaction): void {
  if (tx.lines.length < 2 || tx.lines.length > MAX_LINES) {
    throw new Error(`Islem 2-${MAX_LINES} satir icermelidir`);
  }
  let debit = 0;
  let credit = 0;
  for (const line of tx.lines) {
    if (!Number.isSafeInteger(line.amount) || line.amount < 1) {
      throw new Error(`Gecersiz tutar: ${line.amount} (pozitif tam sayi kurus olmali)`);
    }
    if (line.side === 'debit') debit += line.amount;
    else credit += line.amount;
  }
  if (!Number.isSafeInteger(debit) || debit !== credit) {
    throw new Error(`Borc (${debit}) ve alacak (${credit}) toplami esit degil`);
  }
  if (tx.totalAmount !== debit) {
    throw new Error('totalAmount satir toplamiyla uyusmuyor');
  }
}

type Label =
  | { kind: 'idem' | 'tx' | 'entry' | 'counter' | 'record' }
  | { kind: 'account'; accountId: string }
  | { kind: 'replace'; label: string }
  | { kind: 'outbox'; eventId: string }
  | { kind: 'lock' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Islem basligi, satirlar, hesap bakiyeleri, idempotency kaydi (ve varsa sayac/belge) TEK
 * `TransactWriteItems` ile yazilir: ya hepsi ya hicbiri. Bakiyeler `ADD` ile atomik artirilir
 * (sicak hesaplarda okuma-yazma yarisi olmaz); `expectedVersions` verilen hesaplarda ek olarak
 * optimistic locking uygulanir.
 */
export async function postTransaction(input: PostInput): Promise<void> {
  const { transaction, idempotency, expectedVersions, counter, record, outbox, audit } = input;
  await postBatch({
    transactions: [transaction],
    idempotency,
    expectedVersions,
    counter,
    records: record ? [record] : undefined,
    outbox,
    audit,
  });
}

/**
 * `postTransaction`'in coklu islem hali. Ayni hesap birden fazla islemde gecse de bakiyesi
 * TEK `Update` ile (birlesik delta) guncellenir: DynamoDB bir istekte ayni ogeye iki islem
 * yapilmasina izin vermez.
 *
 * Oge sirasi: idempotency, (islem basligi + satirlar) x N, hesaplar, sayac, belgeler,
 * surumlu belgeler, outbox olaylari. Tek islemde `postTransaction` ile birebir aynidir.
 */
export async function postBatch(input: PostBatchInput): Promise<void> {
  const { transactions, idempotency, expectedVersions = {}, counter, records = [], replaceRecords = [], newDocs = [], accountPatches = {}, outbox = [] } = input;
  const anchor = transactions[0] ?? newDocs[0] ?? replaceRecords[0]?.item;
  if (!anchor) throw new Error('En az bir islem veya belge gerekli');
  const apartmentId = transactions[0]?.siteId ?? anchor.PK.slice(anchor.PK.indexOf('#') + 1);
  const pk = tenantPk(apartmentId);
  const ids = new Set<string>();
  for (const tx of transactions) {
    assertBalanced(tx);
    if (tx.siteId !== apartmentId || tx.PK !== pk || tx.SK !== financeKeys.transaction(apartmentId, tx.transactionId).SK) {
      throw new Error('Islem anahtari tenant/kimlikle uyusmuyor');
    }
    if (ids.has(tx.transactionId)) throw new Error(`Ayni islem iki kez verildi: ${tx.transactionId}`);
    ids.add(tx.transactionId);
  }
  for (const doc of [...records, ...replaceRecords.map((r) => r.item), ...newDocs]) {
    if (doc.PK !== pk) throw new Error('Belge anahtari tenant ile uyusmuyor');
  }
  const increment = counter?.increment ?? 1;
  if (counter && (!Number.isSafeInteger(increment) || increment < 1)) throw new Error('Gecersiz sayac artisi');

  const deltas = new Map<string, number>();
  /** Hesap basina bu yazimdaki en erken islem tarihi (kapama kilidi kosulu). */
  const minDate = new Map<string, IsoDate>();
  for (const tx of transactions) {
    for (const line of tx.lines) {
      const signed = line.side === 'debit' ? line.amount : -line.amount;
      deltas.set(line.accountId, (deltas.get(line.accountId) ?? 0) + signed);
      const cur = minDate.get(line.accountId);
      if (!cur || tx.date < cur) minDate.set(line.accountId, tx.date);
    }
  }
  for (const accountId of Object.keys(accountPatches)) if (!deltas.has(accountId)) deltas.set(accountId, 0);

  const createdAt =
    transactions[0]?.createdAt ?? ((anchor as unknown as { updatedAt?: string; createdAt?: string }).updatedAt ?? new Date().toISOString());
  // Olay dogrulamasi (tenant, kimlik, tekillik) DynamoDB'ye gitmeden.
  const outboxItems = toOutboxItems(outbox, createdAt, apartmentId);
  const { client, tableName } = getDynamo();
  const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [];
  const labels: Label[] = [];
  const add = (label: Label, item: (typeof items)[number]) => {
    labels.push(label);
    items.push(item);
  };
  const notExists = 'attribute_not_exists(PK)';

  add(
    { kind: 'idem' },
    {
      Put: {
        TableName: tableName,
        Item: {
          ...financeKeys.idempotency(apartmentId, idempotency.id),
          entityType: 'IDEMPOTENCY',
          transactionId: transactions[0]?.transactionId,
          recordId: idempotency.recordId,
          ...(idempotency.transactionIds ? { transactionIds: idempotency.transactionIds } : {}),
          ...(idempotency.recordIds ? { recordIds: idempotency.recordIds } : {}),
          fingerprint: idempotency.fingerprint,
          createdAt,
        },
        ConditionExpression: notExists,
      },
    },
  );
  for (const tx of transactions) {
    add({ kind: 'tx' }, { Put: { TableName: tableName, Item: tx, ConditionExpression: notExists } });
    for (const entry of toLedgerEntries(tx)) {
      add({ kind: 'entry' }, { Put: { TableName: tableName, Item: entry, ConditionExpression: notExists } });
    }
  }

  for (const [accountId, delta] of deltas) {
    const expected = expectedVersions[accountId];
    const patch = accountPatches[accountId];
    const lockDate = patch?.bypassLock ? undefined : minDate.get(accountId);
    const conditions = ['attribute_exists(PK)'];
    if (expected !== undefined) conditions.push('#version = :expectedVersion');
    // Kapama kilidi: hesaba kapatilmis tarih (dahil) ve oncesine kayit yazilamaz.
    if (lockDate) conditions.push('(attribute_not_exists(#closedThrough) OR #closedThrough < :lockDate)');
    const sets = ['#updatedAt = :now'];
    let remove = '';
    if (patch) {
      if (patch.closedThrough === null) remove = ' REMOVE #closedThrough';
      else sets.push('#closedThrough = :closedThrough');
    }
    const usesClosed = Boolean(lockDate || patch);
    add(
      { kind: 'account', accountId },
      {
        Update: {
          TableName: tableName,
          Key: financeKeys.account(apartmentId, accountId),
          UpdateExpression: `SET ${sets.join(', ')} ADD #balance :delta, #version :one${remove}`,
          ConditionExpression: conditions.join(' AND '),
          ExpressionAttributeNames: {
            '#updatedAt': 'updatedAt',
            '#balance': 'balance',
            '#version': 'version',
            ...(usesClosed ? { '#closedThrough': 'closedThrough' } : {}),
          },
          ExpressionAttributeValues: {
            ':now': createdAt,
            ':delta': delta,
            ':one': 1,
            ...(expected === undefined ? {} : { ':expectedVersion': expected }),
            ...(lockDate ? { ':lockDate': lockDate } : {}),
            ...(patch && patch.closedThrough !== null ? { ':closedThrough': patch.closedThrough } : {}),
          },
        },
      },
    );
  }

  if (counter) {
    add(
      { kind: 'counter' },
      {
        Update: {
          TableName: tableName,
          Key: financeKeys.counter(apartmentId, counter.name),
          UpdateExpression: 'SET #value = :next, #updatedAt = :now',
          ConditionExpression: counter.expected === 0 ? notExists : '#value = :expected',
          ExpressionAttributeNames: { '#value': 'value', '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: {
            ':next': counter.expected + increment,
            ':now': createdAt,
            ...(counter.expected === 0 ? {} : { ':expected': counter.expected }),
          },
        },
      },
    );
  }

  for (const record of records) {
    add({ kind: 'record' }, { Put: { TableName: tableName, Item: record, ConditionExpression: notExists } });
  }

  for (const doc of newDocs) {
    add({ kind: 'record' }, { Put: { TableName: tableName, Item: doc, ConditionExpression: notExists } });
  }

  for (const r of replaceRecords) {
    if (r.item.version !== r.expectedVersion + 1) throw new Error('Surumlu belge surumu bir artirilmali');
    add(
      { kind: 'replace', label: r.label },
      {
        Put: {
          TableName: tableName,
          Item: r.item,
          ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':expectedVersion': r.expectedVersion },
        },
      },
    );
  }

  for (const item of outboxItems) {
    add(
      { kind: 'outbox', eventId: item.eventId },
      { Put: { TableName: tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
    );
  }

  // Finans 2.4: mali donem kilidi (veri ogelerinin SONUNDA; denetim kaydi her zaman en son). Islemlerin en erken tarihi kilit tarihinden sonra olmali;
  // kayit yoksa (hic kapanis yapilmamis) kosul saglanir. Ayni atomik yazimda kontrol edilir.
  const earliest = earliestDate(transactions);
  if (earliest) {
    add(
      { kind: 'lock' },
      {
        ConditionCheck: {
          TableName: tableName,
          Key: periodKeys.lock(apartmentId),
          ConditionExpression: 'attribute_not_exists(PK) OR attribute_not_exists(#lockedThrough) OR #lockedThrough < :earliest',
          ExpressionAttributeNames: { '#lockedThrough': 'lockedThrough' },
          ExpressionAttributeValues: { ':earliest': earliest },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        },
      },
    );
  }

  if (items.length > MAX_TRANSACT_ITEMS) {
    throw new Error(`Atomik yazim ${MAX_TRANSACT_ITEMS} ogeyi asamaz (${items.length})`);
  }
  // Denetim kaydi (varsa) SON oge olarak ayni transaction'a eklenir; zincir yarisi icinde tekrarlanir.
  const auditDraft = input.audit ?? ledgerAuditDraft(input, apartmentId);

  for (let attempt = 1; ; attempt++) {
    try {
      await sendWithAudit(client, items, auditDraft);
      return;
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        const reasons = err.CancellationReasons ?? [];
        const failed = reasons.findIndex((r) => r.Code === 'ConditionalCheckFailed');
        const label = failed >= 0 ? labels[failed] : undefined;

        if (label?.kind === 'lock') {
          // Ham (marshall edilmis) eski kayit: { lockedThrough: { S: 'YYYY-MM-DD' } }.
          const old = reasons[failed]?.Item as Record<string, { S?: string }> | undefined;
          throw new PeriodClosedError(old?.lockedThrough?.S);
        }
        if (label?.kind === 'idem') throw new LedgerConflictError('duplicate');
        if (label?.kind === 'counter') throw new LedgerConflictError('counter');
        // Ayni olay zaten yazilmis: ayni islem daha once kaydedilmis demektir (deterministik kimlik).
        if (label?.kind === 'outbox') {
          throw new LedgerConflictError('duplicate', `Olay zaten kayitli: ${label.eventId}`, `outbox:${label.eventId}`);
        }
        if (label?.kind === 'replace') {
          throw new LedgerConflictError('precondition', `Belge degismis: ${label.label}`, label.label);
        }
        if (label?.kind === 'account') {
          // Hangi kosul tuttu? Kilit tarihini okuyarak ayirt et (nadir yol; tek okuma).
          const lockDate = accountPatches[label.accountId]?.bypassLock ? undefined : minDate.get(label.accountId);
          if (lockDate) {
            const acc = await getTenantItem<Account>(financeKeys.account(apartmentId, label.accountId)).catch(() => undefined);
            if (acc?.closedThrough && acc.closedThrough >= lockDate) {
              throw new LedgerConflictError('closed', `Hesap ${acc.closedThrough} tarihine kadar kapatilmis`, label.accountId, acc.closedThrough);
            }
            if (acc && expectedVersions[label.accountId] === undefined) {
              throw new LedgerConflictError('version', `Hesap: ${label.accountId}`);
            }
          }
          throw new LedgerConflictError(
            expectedVersions[label.accountId] === undefined ? 'account_missing' : 'version',
            `Hesap: ${label.accountId}`,
          );
        }
        // Es zamanli islem cakismasi gecicidir; kisa beklemeyle tekrar denenir.
        if (failed < 0 && reasons.some((r) => r.Code === 'TransactionConflict') && attempt < MAX_ATTEMPTS) {
          await sleep(25 * attempt);
          continue;
        }
      }
      throw toDataAccessError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Depo (okuma ve hesap yonetimi)
// ---------------------------------------------------------------------------

export type FinanceRepository = {
  getAccount(apartmentId: string, accountId: string): Promise<Account | undefined>;
  listAccounts(apartmentId: string): Promise<Account[]>;
  createAccount(account: Account): Promise<void>;
  /** Yalnizca ad/durum gunceller (bakiyeye dokunmaz); `expectedVersion` ile optimistic locking. */
  updateAccount(account: Account, expectedVersion: number): Promise<void>;
  /** Eksik hesaplari olusturur; var olanlari sessizce atlar. */
  ensureAccounts(accounts: Account[]): Promise<void>;

  getTransaction(apartmentId: string, transactionId: string): Promise<Transaction | undefined>;
  getPayment(apartmentId: string, paymentId: string): Promise<Payment | undefined>;
  getExpense(apartmentId: string, expenseId: string): Promise<Expense | undefined>;
  /**
   * Apartmanin TUM gider kayitlari. Yillar icinde sinirsiz buyur: istek yolunda kullanmayin
   * (yalnizca bakim betikleri / testler); secici listeler `listRecentExpenses` kullanir.
   */
  listExpenses?(apartmentId: string): Promise<Expense[]>;
  /**
   * En yeni giderler (tarih azalan), en fazla `limit` (1-500); `from` verilirse o tarih ve sonrasi.
   * GSI1 tarih dizininden okunur: maliyet gider sayisindan bagimsiz, `limit` ile sinirli.
   */
  listRecentExpenses?(apartmentId: string, q: { limit: number; from?: string }): Promise<Expense[]>;
  getIdempotency(apartmentId: string, id: string): Promise<IdempotencyRecord | undefined>;
  getCounter(apartmentId: string, name: string): Promise<number>;

  /**
   * Islem basliklari, tarih araligina gore (SK = `TX#<YYYYMMDD>-...` kronolojik).
   * `limit` verilirse sayfalanir; `cursor` bir onceki sayfanin devami.
   */
  listTransactions(apartmentId: string, query?: TransactionQuery): Promise<{ items: Transaction[]; cursor?: string }>;

  /**
   * Finans 2.4: tek hesabin defter satirlari (`LE#<accountId>#<YYYYMMDD-…>#<satir>`), tarih
   * araligiyla (dahil). Tam defter taramasi yerine hesap kapsamli okuma icin; kronolojik.
   */
  listAccountEntries?(apartmentId: string, accountId: string, range?: { from?: IsoDate; to?: IsoDate }): Promise<LedgerEntry[]>;
  /** Finans 2.4: islem basliklarini kimlikle toplu okur (BatchGet, tutarli; sira garanti degil). */
  getTransactions?(apartmentId: string, transactionIds: readonly string[]): Promise<Transaction[]>;

  postTransaction(input: PostInput): Promise<void>;
  postBatch(input: PostBatchInput): Promise<void>;
  /**
   * Defter yazimina bagli olmayan (ozet) olaylari outbox'a yazar: her olay tek kayit,
   * `attribute_not_exists` kosullu. Olay zaten varsa sessizce atlanir (deterministik kimlik;
   * ayni toplu islemin tekrari ikinci ozet uretmez). Yazilan olay sayisini doner.
   */
  recordEvents(apartmentId: string, events: DomainEvent[]): Promise<number>;
};

export type TransactionQuery = {
  /** Dahil, YYYY-MM-DD */
  from?: string;
  /** Dahil, YYYY-MM-DD */
  to?: string;
  newestFirst?: boolean;
  limit?: number;
  cursor?: string;
};

const encodeCursor = (key: QueryCommandOutput['LastEvaluatedKey']) =>
  key ? Buffer.from(JSON.stringify(key)).toString('base64url') : undefined;

function decodeCursor(apartmentId: string, cursor: string): Record<string, unknown> {
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    // Imleç istemciden gelir: baska apartmanin anahtari ile devam edilemez.
    if (key.PK !== tenantPk(apartmentId) || typeof key.SK !== 'string' || !key.SK.startsWith('TX#')) {
      throw new Error('tenant');
    }
    return { PK: key.PK, SK: key.SK };
  } catch {
    throw new InvalidCursorError();
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super('Gecersiz sayfa imleci');
    this.name = 'InvalidCursorError';
  }
}

const BATCH_GET_SIZE = 100;
const MAX_BATCH_ROUNDS = 5;

/** Islem basliklari, kimlikle (BatchGet; islenmeyen anahtarlar ustel bekleme ile yeniden). */
/**
 * Finans 2.4-6: verilen hesaplara satir yazan islemler (LE# hesap okuyucusu + BatchGet), tam TX#
 * taramasi yerine. LE# kayitlari islemle ayni atomik yazimda olustugu icin kume tamdir (gece
 * denetimi `tx_entries_mismatch` ile dogrular). Okuyucusu olmayan depoda tam taramaya duser.
 * Sira: islem kimligi (tarih onekli) artan - `listTransactions` ile ayni.
 */
export async function accountTransactions(
  repo: Pick<FinanceRepository, 'listTransactions'> & Partial<Pick<FinanceRepository, 'listAccountEntries' | 'getTransactions'>>,
  apartmentId: string,
  accountIds: readonly string[],
): Promise<Transaction[]> {
  const { listAccountEntries, getTransactions } = repo;
  if (!listAccountEntries || !getTransactions) {
    const wanted = new Set(accountIds);
    return (await repo.listTransactions(apartmentId)).items.filter((t) => t.lines.some((l) => wanted.has(l.accountId)));
  }
  const entries = (await Promise.all(accountIds.map((id) => listAccountEntries(apartmentId, id)))).flat();
  const ids = [...new Set(entries.map((e) => e.transactionId))];
  const txs = ids.length ? await getTransactions(apartmentId, ids) : [];
  return [...txs].sort((a, b) => a.transactionId.localeCompare(b.transactionId));
}

export async function batchGetTransactions(apartmentId: string, ids: readonly string[]): Promise<Transaction[]> {
  const { client, tableName } = getDynamo();
  const out: Transaction[] = [];
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += BATCH_GET_SIZE) {
    let keys: Record<string, unknown>[] | undefined = unique.slice(i, i + BATCH_GET_SIZE).map((id) => financeKeys.transaction(apartmentId, id));
    for (let round = 0; keys && keys.length > 0; round++) {
      if (round >= MAX_BATCH_ROUNDS) throw toDataAccessError(new Error('BatchGet islenemeyen anahtarlar kaldi'));
      if (round > 0) await sleep(50 * 2 ** round);
      let res: BatchGetCommandOutput;
      try {
        res = await client.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: keys, ConsistentRead: true } } }));
      } catch (err) {
        throw toDataAccessError(err);
      }
      out.push(...((res.Responses?.[tableName] ?? []) as Transaction[]));
      keys = res.UnprocessedKeys?.[tableName]?.Keys;
    }
  }
  // Savunma: baska tenant'a ait kayit asla donmez (anahtar zaten tenant'tan turetildi).
  return out.filter((tx) => tx.siteId === apartmentId);
}

/**
 * Hesap defter satirlari. SK = `LE#<accountId>#<transactionId>#<satir>`, `transactionId` gunle
 * baslar (`YYYYMMDD-…`): tarih araligi SK uzerinde BETWEEN ile daraltilir ('~' > rakam/harf).
 */
export async function queryAccountEntries(apartmentId: string, accountId: string, range: { from?: IsoDate; to?: IsoDate } = {}): Promise<LedgerEntry[]> {
  const { client, tableName } = getDynamo();
  const base = `${skKey('LE', accountId)}${KEY_SEPARATOR}`;
  const lower = `${base}${(range.from ?? '0000-00-00').replaceAll('-', '')}`;
  const upper = `${base}${(range.to ?? '9999-99-99').replaceAll('-', '')}~`;
  const items: LedgerEntry[] = [];
  let startKey: Record<string, unknown> | undefined;
  try {
    do {
      const out: QueryCommandOutput = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :lo AND :hi',
          ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
          ExpressionAttributeValues: { ':pk': tenantPk(apartmentId), ':lo': lower, ':hi': upper },
          ConsistentRead: true,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      items.push(...((out.Items ?? []) as LedgerEntry[]));
      startKey = out.LastEvaluatedKey;
    } while (startKey);
  } catch (err) {
    throw toDataAccessError(err);
  }
  return items.filter((e) => e.siteId === apartmentId && e.accountId === accountId);
}

async function queryTransactions(
  apartmentId: string,
  q: TransactionQuery = {},
): Promise<{ items: Transaction[]; cursor?: string }> {
  const { client, tableName } = getDynamo();
  const pk = tenantPk(apartmentId);
  // TX#<YYYYMMDD>-<uuid>: araligin ust siniri gunun tum islemlerini kapsamali ('~' > rakam/harf).
  const lower = `TX#${(q.from ?? '0000-00-00').replaceAll('-', '')}`;
  const upper = `TX#${(q.to ?? '9999-99-99').replaceAll('-', '')}~`;
  const items: Transaction[] = [];
  let startKey: Record<string, unknown> | undefined = q.cursor ? decodeCursor(apartmentId, q.cursor) : undefined;
  try {
    do {
      const out: QueryCommandOutput = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :lo AND :hi',
          ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
          ExpressionAttributeValues: { ':pk': pk, ':lo': lower, ':hi': upper },
          ScanIndexForward: !q.newestFirst,
          ...(q.limit ? { Limit: q.limit - items.length } : {}),
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      items.push(...((out.Items ?? []) as Transaction[]));
      startKey = out.LastEvaluatedKey;
      if (q.limit && items.length >= q.limit) return { items, cursor: encodeCursor(startKey) };
    } while (startKey);
    return { items };
  } catch (err) {
    throw toDataAccessError(err);
  }
}

async function putAccount(account: Account, ignoreExisting: boolean): Promise<void> {
  const { client, tableName } = getDynamo();
  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: account,
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (err) {
    if (ignoreExisting && err instanceof ConditionalCheckFailedException) return;
    throw toDataAccessError(err);
  }
}

export function createFinanceRepository(): FinanceRepository {
  return {
    getAccount: (apartmentId, accountId) =>
      getTenantItem<Account>(financeKeys.account(apartmentId, accountId)),
    listAccounts: (apartmentId) =>
      queryTenantAll<Account>(apartmentId, ACCOUNT_PREFIX, { ConsistentRead: true }),
    createAccount: (account) => putAccount(account, false),

    async updateAccount(account, expectedVersion) {
      const { client, tableName } = getDynamo();
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: financeKeys.account(account.siteId, account.accountId),
            // Finans 2.4: hesap kodu (bos ise kaldirilir).
            UpdateExpression: `SET #name = :name, #status = :status, #updatedAt = :now, #updatedBy = :by${account.code ? ', #code = :code' : ''} ADD #version :one${account.code ? '' : ' REMOVE #code'}`,
            ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
            ExpressionAttributeNames: {
              '#name': 'name',
              '#status': 'status',
              '#updatedAt': 'updatedAt',
              '#updatedBy': 'updatedBy',
              '#version': 'version',
              '#code': 'code',
            },
            ExpressionAttributeValues: {
              ':name': account.name,
              ':status': account.status,
              ...(account.code ? { ':code': account.code } : {}),
              ':now': account.updatedAt,
              ':by': account.updatedBy,
              ':one': 1,
              ':expectedVersion': expectedVersion,
            },
          }),
        );
      } catch (err) {
        throw toDataAccessError(err);
      }
    },

    async ensureAccounts(accounts) {
      // Bagimsiz kayitlar: paralel yazim guvenli (islem cakismasi yok).
      for (let i = 0; i < accounts.length; i += 25) {
        await Promise.all(accounts.slice(i, i + 25).map((a) => putAccount(a, true)));
      }
    },

    getTransaction: (apartmentId, id) =>
      getTenantItem<Transaction>(financeKeys.transaction(apartmentId, id)),
    getPayment: (apartmentId, id) => getTenantItem<Payment>(financeKeys.payment(apartmentId, id)),
    getExpense: (apartmentId, id) => getTenantItem<Expense>(financeKeys.expense(apartmentId, id)),
    listExpenses: (apartmentId) => queryTenantAll<Expense>(apartmentId, `EXP${KEY_SEPARATOR}`),
    async listRecentExpenses(apartmentId, q) {
      const limit = Math.max(1, Math.min(500, Math.floor(q.limit)));
      const { client, tableName } = getDynamo();
      const pk = financeKeys.expenseIndex(apartmentId, '', '').GSI1PK;
      const items: Expense[] = [];
      let startKey: QueryCommandOutput['LastEvaluatedKey'];
      try {
        do {
          const out: QueryCommandOutput = await client.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: 'GSI1',
              KeyConditionExpression: q.from ? 'GSI1PK = :pk AND GSI1SK >= :from' : 'GSI1PK = :pk',
              ExpressionAttributeValues: { ':pk': pk, ...(q.from ? { ':from': q.from } : {}) },
              ScanIndexForward: false,
              Limit: limit - items.length,
              ...(startKey ? { ExclusiveStartKey: startKey } : {}),
            }),
          );
          for (const item of out.Items ?? []) {
            // Dizin anahtari tenant'a ozel; yine de baska apartmanin kaydi asla donmez.
            if ((item as Expense).siteId === apartmentId) items.push(item as Expense);
          }
          startKey = out.LastEvaluatedKey;
        } while (startKey && items.length < limit);
      } catch (err) {
        throw toDataAccessError(err);
      }
      return items;
    },
    getIdempotency: (apartmentId, id) =>
      getTenantItem<IdempotencyRecord>(financeKeys.idempotency(apartmentId, id)),
    async getCounter(apartmentId, name) {
      const item = await getTenantItem<{ value?: number }>(financeKeys.counter(apartmentId, name));
      return item?.value ?? 0;
    },

    listTransactions: queryTransactions,
    listAccountEntries: queryAccountEntries,
    getTransactions: batchGetTransactions,

    postTransaction,
    postBatch,
    async recordEvents(apartmentId, events) {
      const { client, tableName } = getDynamo();
      let written = 0;
      for (const item of toOutboxItems(events, new Date().toISOString(), apartmentId)) {
        try {
          await client.send(new PutCommand({ TableName: tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
          written++;
        } catch (err) {
          if (err instanceof ConditionalCheckFailedException) continue;
          throw toDataAccessError(err);
        }
      }
      return written;
    },
  };
}

export const financeRepository: FinanceRepository = createFinanceRepository();
