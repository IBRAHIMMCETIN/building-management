import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  PutCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  getDynamo,
  getTenantItem,
  queryTenantAll,
  skKey,
  tenantPk,
  toDataAccessError,
} from '../../config/dynamodb.js';
import type { TableKeys } from '../core/types.js';
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

export type LedgerConflictReason = 'duplicate' | 'version' | 'counter' | 'account_missing';

/** Beklenen, servis katmaninin ele alacagi yazim cakismalari. */
export class LedgerConflictError extends Error {
  readonly reason: LedgerConflictReason;

  constructor(reason: LedgerConflictReason, message = `Defter cakismasi: ${reason}`) {
    super(message);
    this.name = 'LedgerConflictError';
    this.reason = reason;
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
};

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
  | { kind: 'account'; accountId: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Islem basligi, satirlar, hesap bakiyeleri, idempotency kaydi (ve varsa sayac/belge) TEK
 * `TransactWriteItems` ile yazilir: ya hepsi ya hicbiri. Bakiyeler `ADD` ile atomik artirilir
 * (sicak hesaplarda okuma-yazma yarisi olmaz); `expectedVersions` verilen hesaplarda ek olarak
 * optimistic locking uygulanir.
 */
export async function postTransaction(input: PostInput): Promise<void> {
  const { transaction: tx, idempotency, expectedVersions = {}, counter, record } = input;
  assertBalanced(tx);

  const apartmentId = tx.siteId;
  const pk = tenantPk(apartmentId);
  if (tx.PK !== pk || tx.SK !== financeKeys.transaction(apartmentId, tx.transactionId).SK) {
    throw new Error('Islem anahtari tenant/kimlikle uyusmuyor');
  }
  if (record && record.PK !== pk) {
    throw new Error('Belge anahtari tenant ile uyusmuyor');
  }

  const deltas = new Map<string, number>();
  for (const line of tx.lines) {
    const signed = line.side === 'debit' ? line.amount : -line.amount;
    deltas.set(line.accountId, (deltas.get(line.accountId) ?? 0) + signed);
  }

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
          transactionId: tx.transactionId,
          recordId: idempotency.recordId,
          fingerprint: idempotency.fingerprint,
          createdAt: tx.createdAt,
        },
        ConditionExpression: notExists,
      },
    },
  );
  add({ kind: 'tx' }, { Put: { TableName: tableName, Item: tx, ConditionExpression: notExists } });
  for (const entry of toLedgerEntries(tx)) {
    add({ kind: 'entry' }, { Put: { TableName: tableName, Item: entry, ConditionExpression: notExists } });
  }

  for (const [accountId, delta] of deltas) {
    const expected = expectedVersions[accountId];
    add(
      { kind: 'account', accountId },
      {
        Update: {
          TableName: tableName,
          Key: financeKeys.account(apartmentId, accountId),
          UpdateExpression: 'SET #updatedAt = :now ADD #balance :delta, #version :one',
          ConditionExpression:
            expected === undefined
              ? 'attribute_exists(PK)'
              : 'attribute_exists(PK) AND #version = :expectedVersion',
          ExpressionAttributeNames: {
            '#updatedAt': 'updatedAt',
            '#balance': 'balance',
            '#version': 'version',
          },
          ExpressionAttributeValues: {
            ':now': tx.createdAt,
            ':delta': delta,
            ':one': 1,
            ...(expected === undefined ? {} : { ':expectedVersion': expected }),
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
            ':next': counter.expected + 1,
            ':now': tx.createdAt,
            ...(counter.expected === 0 ? {} : { ':expected': counter.expected }),
          },
        },
      },
    );
  }

  if (record) {
    add({ kind: 'record' }, { Put: { TableName: tableName, Item: record, ConditionExpression: notExists } });
  }

  for (let attempt = 1; ; attempt++) {
    try {
      await client.send(new TransactWriteCommand({ TransactItems: items }));
      return;
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        const reasons = err.CancellationReasons ?? [];
        const failed = reasons.findIndex((r) => r.Code === 'ConditionalCheckFailed');
        const label = failed >= 0 ? labels[failed] : undefined;

        if (label?.kind === 'idem') throw new LedgerConflictError('duplicate');
        if (label?.kind === 'counter') throw new LedgerConflictError('counter');
        if (label?.kind === 'account') {
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
  getIdempotency(apartmentId: string, id: string): Promise<IdempotencyRecord | undefined>;
  getCounter(apartmentId: string, name: string): Promise<number>;

  postTransaction(input: PostInput): Promise<void>;
};

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
            UpdateExpression:
              'SET #name = :name, #status = :status, #updatedAt = :now, #updatedBy = :by ADD #version :one',
            ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
            ExpressionAttributeNames: {
              '#name': 'name',
              '#status': 'status',
              '#updatedAt': 'updatedAt',
              '#updatedBy': 'updatedBy',
              '#version': 'version',
            },
            ExpressionAttributeValues: {
              ':name': account.name,
              ':status': account.status,
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
    getIdempotency: (apartmentId, id) =>
      getTenantItem<IdempotencyRecord>(financeKeys.idempotency(apartmentId, id)),
    async getCounter(apartmentId, name) {
      const item = await getTenantItem<{ value?: number }>(financeKeys.counter(apartmentId, name));
      return item?.value ?? 0;
    },

    postTransaction,
  };
}

export const financeRepository: FinanceRepository = createFinanceRepository();
