import { DataAccessError } from '../../src/config/dynamodb.js';
import { toKurus } from '../../src/modules/core/types.js';
import {
  type FinanceRepository,
  LedgerConflictError,
  type PostBatchInput,
  type PostInput,
} from '../../src/modules/finance/repository.js';
import type { Account, Expense, IdempotencyRecord, Payment, Transaction } from '../../src/modules/finance/types.js';
import type { AccountSummaryItem } from '../../src/modules/finance/accountSummary.js';
import type { DomainEvent } from '../../src/events/publisher.js';
import { PeriodClosedError } from '../../src/modules/finance/periodLock.js';

/** DynamoDB semantigini taklit eden bellek ici defter: atomik, kosullu, surumlu. */
export function createFakeFinanceRepo(defaultApartmentId = 'apt-1') {
  const accounts = new Map<string, Account>();
  const transactions = new Map<string, Transaction>();
  const payments = new Map<string, Payment>();
  const expenses = new Map<string, Expense>();
  const idem = new Map<string, IdempotencyRecord>();
  const counters = new Map<string, number>();
  const posted: PostInput[] = [];
  const k = (apt: string, id: string) => `${apt}|${id}`;
  let failNextPost: Error | undefined;

  /** Surumlu belgeler (replaceRecords): PK|SK -> belge. Odeme niyetleri burada tutulur. */
  const docs = new Map<string, Record<string, unknown> & { PK: string; SK: string; version: number }>();
  const batches: PostBatchInput[] = [];
  /** Transactional outbox: `apt|eventId` -> olay (yazim sirasiyla). */
  const outbox = new Map<string, DomainEvent>();
  /** P1-a: alt cari ozetleri (`apt|accountId`), turetilmis veri. */
  const summaries = new Map<string, AccountSummaryItem>();

  /**
   * Gercek tabloda idempotency kaydi tek anahtardadir (`IDEM#<id>`): `postBatch.idempotency` ile
   * de, `newDocs` icinde yazilan isaretle de (ornegin banka geri almasinin `REV_<islem>` kaydi)
   * ayni kayit olusur. Sahte depo ikisini de gorur; boylece elle ikinci ters kayit engellenir.
   */
  function idemOf(apt: string, id: string): IdempotencyRecord | undefined {
    const direct = idem.get(k(apt, id));
    if (direct) return direct;
    const doc = docs.get(`APT#${apt}|IDEM#${id}`) as (Record<string, unknown> & Partial<IdempotencyRecord>) | undefined;
    if (!doc || typeof doc.transactionId !== 'string' || typeof doc.fingerprint !== 'string') return undefined;
    return {
      transactionId: doc.transactionId,
      fingerprint: doc.fingerprint,
      ...(doc.recordId ? { recordId: doc.recordId } : {}),
      ...(doc.transactionIds ? { transactionIds: doc.transactionIds } : {}),
      ...(doc.recordIds ? { recordIds: doc.recordIds } : {}),
    } as IdempotencyRecord;
  }

  async function postBatch(input: PostBatchInput): Promise<void> {
    if (failNextPost) {
      const e = failNextPost;
      failNextPost = undefined;
      throw e;
    }
    const newDocs = input.newDocs ?? [];
    const patches = input.accountPatches ?? {};
    const anchor = input.transactions[0] ?? newDocs[0] ?? input.replaceRecords?.[0]?.item;
    if (!anchor) throw new Error('En az bir islem veya belge gerekli');
    const apt = input.transactions[0]?.siteId ?? anchor.PK.slice('APT#'.length);
    // 1) Tum kosullar (atomiklik: hicbir sey yazilmadan once)
    for (const tx of input.transactions) {
      let debit = 0;
      let credit = 0;
      for (const l of tx.lines) {
        if (!Number.isSafeInteger(l.amount) || l.amount < 1) throw new Error('gecersiz tutar');
        if (l.side === 'debit') debit += l.amount;
        else credit += l.amount;
      }
      if (debit !== credit) throw new Error('dengesiz islem');
      if (tx.siteId !== apt) throw new Error('tenant');
    }
    // Finans 2.4: mali donem kilidi (gercek depoda ayni TransactWriteItems icinde ConditionCheck).
    const lockDoc = docs.get(`APT#${apt}|FINLOCK`) as { lockedThrough?: string } | undefined;
    const earliest = input.transactions.reduce<string | undefined>((m, t) => (!m || t.date < m ? t.date : m), undefined);
    if (lockDoc?.lockedThrough && earliest && earliest <= lockDoc.lockedThrough) throw new PeriodClosedError(lockDoc.lockedThrough);
    if (idemOf(apt, input.idempotency.id)) throw new LedgerConflictError('duplicate');
    for (const tx of input.transactions) {
      for (const l of tx.lines) {
        const acc = accounts.get(k(apt, l.accountId));
        if (!acc) throw new LedgerConflictError('account_missing');
        const exp = input.expectedVersions?.[l.accountId];
        if (exp !== undefined && acc.version !== exp) throw new LedgerConflictError('version');
        // Kapama kilidi (repository.ts ile ayni kosul).
        if (!patches[l.accountId]?.bypassLock && acc.closedThrough && tx.date <= acc.closedThrough) {
          throw new LedgerConflictError('closed', `Hesap ${acc.closedThrough} tarihine kadar kapatilmis`, l.accountId, acc.closedThrough);
        }
      }
    }
    for (const id of Object.keys(patches)) {
      if (!accounts.has(k(apt, id))) throw new LedgerConflictError('account_missing');
    }
    for (const d of newDocs) {
      if (docs.has(`${d.PK}|${d.SK}`)) throw new Error('belge zaten var');
    }
    if (input.counter && (counters.get(k(apt, input.counter.name)) ?? 0) !== input.counter.expected) {
      throw new LedgerConflictError('counter');
    }
    for (const r of input.replaceRecords ?? []) {
      const cur = docs.get(`${r.item.PK}|${r.item.SK}`);
      if (!cur || cur.version !== r.expectedVersion) {
        throw new LedgerConflictError('precondition', `Belge degismis: ${r.label}`, r.label);
      }
    }
    for (const e of input.outbox ?? []) {
      if (e.apartmentId !== apt) throw new Error('olay tenant');
      if (outbox.has(k(apt, e.eventId))) throw new LedgerConflictError('duplicate', 'olay', `outbox:${e.eventId}`);
    }
    // 2) Yazim
    idem.set(k(apt, input.idempotency.id), {
      transactionId: input.transactions[0]?.transactionId as string,
      recordId: input.idempotency.recordId,
      transactionIds: input.idempotency.transactionIds,
      recordIds: input.idempotency.recordIds,
      fingerprint: input.idempotency.fingerprint,
    });
    for (const tx of input.transactions) {
      transactions.set(k(apt, tx.transactionId), tx);
      for (const l of tx.lines) {
        const acc = accounts.get(k(apt, l.accountId))!;
        accounts.set(k(apt, l.accountId), {
          ...acc,
          balance: toKurus(acc.balance + (l.side === 'debit' ? l.amount : -l.amount)),
          version: acc.version + 1,
        });
      }
    }
    for (const [id, patch] of Object.entries(patches)) {
      const acc = accounts.get(k(apt, id))!;
      const { closedThrough: _old, ...rest } = acc;
      accounts.set(k(apt, id), {
        ...rest,
        ...(patch.closedThrough === null ? {} : { closedThrough: patch.closedThrough }),
        version: input.transactions.some((t) => t.lines.some((l) => l.accountId === id)) ? acc.version : acc.version + 1,
      });
    }
    for (const d of newDocs) {
      docs.set(`${d.PK}|${d.SK}`, d as unknown as Record<string, unknown> & { PK: string; SK: string; version: number });
    }
    if (input.counter) {
      counters.set(k(apt, input.counter.name), input.counter.expected + (input.counter.increment ?? 1));
    }
    for (const record of input.records ?? []) {
      if (record.entityType === 'PAYMENT') payments.set(k(apt, record.paymentId), record);
      if (record.entityType === 'EXPENSE') expenses.set(k(apt, record.expenseId), record);
    }
    for (const r of input.replaceRecords ?? []) {
      docs.set(`${r.item.PK}|${r.item.SK}`, r.item as Record<string, unknown> & { PK: string; SK: string; version: number });
    }
    for (const e of input.outbox ?? []) outbox.set(k(apt, e.eventId), structuredClone(e));
  }

  const repo: FinanceRepository = {
    getAccount: async (apt, id) => accounts.get(k(apt, id)),
    listAccounts: async (apt) => [...accounts.values()].filter((a) => a.siteId === apt),
    createAccount: async (a) => {
      if (accounts.has(k(a.siteId, a.accountId))) throw new DataAccessError('conflict', 'var');
      accounts.set(k(a.siteId, a.accountId), a);
    },
    updateAccount: async (a, expectedVersion) => {
      const cur = accounts.get(k(a.siteId, a.accountId));
      if (!cur || cur.version !== expectedVersion) throw new DataAccessError('conflict', 'surum');
      const { code: _code, ...base } = cur;
      accounts.set(k(a.siteId, a.accountId), { ...base, name: a.name, status: a.status, ...(a.code ? { code: a.code } : {}), version: cur.version + 1 });
    },
    ensureAccounts: async (list) => {
      for (const a of list) if (!accounts.has(k(a.siteId, a.accountId))) accounts.set(k(a.siteId, a.accountId), a);
    },
    getTransaction: async (apt, id) => transactions.get(k(apt, id)),
    getPayment: async (apt, id) => payments.get(k(apt, id)),
    getExpense: async (apt, id) => expenses.get(k(apt, id)),
    listExpenses: async (apt) => [...expenses.values()].filter((e) => e.siteId === apt),
    getIdempotency: async (apt, id) => idemOf(apt, id),
    getCounter: async (apt, name) => counters.get(k(apt, name)) ?? 0,
    // Finans 2.4: LE# hesap okuyucusunun sahtesi (islem satirlarindan turetilir).
    listAccountEntries: async (apt, accountId, range = {}) =>
      [...transactions.values()]
        .filter((t) => t.siteId === apt && t.date >= (range.from ?? '0000-00-00') && t.date <= (range.to ?? '9999-99-99'))
        .sort((a, b) => a.transactionId.localeCompare(b.transactionId))
        .flatMap((t) =>
          t.lines
            .map((l, lineNo) => ({ l, lineNo }))
            .filter(({ l }) => l.accountId === accountId)
            .map(({ l, lineNo }) => ({
              PK: `APT#${apt}`,
              SK: `LE#${accountId}#${t.transactionId}#${lineNo}`,
              entityType: 'LEDGER_ENTRY' as const,
              entryId: `${t.transactionId}#${lineNo}`,
              transactionId: t.transactionId,
              siteId: apt,
              accountId,
              side: l.side,
              amount: l.amount,
              date: t.date,
              lineNo,
              createdAt: t.createdAt,
              createdBy: t.createdBy,
            })),
        ),
    getTransactions: async (apt, ids) => ids.map((id) => transactions.get(k(apt, id))).filter((t): t is Transaction => t !== undefined),
    listTransactions: async (apt, q = {}) => {
      const lo = (q.from ?? '0000-00-00').replaceAll('-', '');
      const hi = (q.to ?? '9999-99-99').replaceAll('-', '') + '~';
      const all = [...transactions.values()]
        .filter((t) => t.siteId === apt && t.transactionId >= lo && t.transactionId <= hi)
        .sort((a, b) => a.transactionId.localeCompare(b.transactionId) * (q.newestFirst ? -1 : 1));
      const start = q.cursor ? Number(q.cursor) : 0;
      if (!q.limit) return { items: all.slice(start) };
      const end = start + q.limit;
      return { items: all.slice(start, end), cursor: end < all.length ? String(end) : undefined };
    },
    listAccountSummaries: async (apt) => [...summaries.values()].filter((x) => x.siteId === apt).map((x) => structuredClone(x)),
    putAccountSummary: async (item) => {
      const cur = summaries.get(k(item.siteId, item.accountId));
      // Gercek depodaki kosul: kayit yoksa veya saklanan surum <= yeni surum.
      if (cur && cur.sourceVersion > item.sourceVersion) return false;
      summaries.set(k(item.siteId, item.accountId), structuredClone(item));
      return true;
    },
    postTransaction: async (input) => {
      await postBatch({
        transactions: [input.transaction],
        idempotency: input.idempotency,
        expectedVersions: input.expectedVersions,
        counter: input.counter,
        records: input.record ? [input.record] : undefined,
        outbox: input.outbox,
      });
      posted.push(input);
    },
    postBatch: async (input) => {
      await postBatch(input);
      batches.push(input);
    },
    recordEvents: async (apt, list) => {
      let written = 0;
      for (const e of list) {
        if (e.apartmentId !== apt) throw new Error('olay tenant');
        if (outbox.has(k(apt, e.eventId))) continue;
        outbox.set(k(apt, e.eventId), structuredClone(e));
        written++;
      }
      return written;
    },
  };

  const balanceOf = (id: string, apt = defaultApartmentId) => accounts.get(k(apt, id))?.balance ?? 0;
  /** Mizan: tum hesap bakiyelerinin toplami her zaman 0 olmali (borc = alacak). */
  const trialBalance = () => [...accounts.values()].reduce((s, a) => s + a.balance, 0);

  return {
    repo,
    accounts,
    transactions,
    payments,
    expenses,
    idem,
    counters,
    posted,
    batches,
    docs,
    outbox,
    summaries,
    /** Outbox'a yazilan olaylar (yazim sirasiyla); istege bagli tur filtresi. */
    events: <T extends DomainEvent['type']>(type?: T) =>
      [...outbox.values()].filter((e): e is Extract<DomainEvent, { type: T }> => !type || e.type === type),
    balanceOf,
    trialBalance,
    failNext: (e: Error) => {
      failNextPost = e;
    },
  };
}

