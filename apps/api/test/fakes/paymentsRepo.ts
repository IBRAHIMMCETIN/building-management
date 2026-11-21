import { PAYOUT_INDEX_PK, PaymentsConflictError, type PaymentsRepository, REVIEW_QUEUE_PK, toStoredIntent, toStoredPayout } from '../../src/modules/payments/repository.js';
import type { IntentKeyRecord, IntentRefRecord, PayoutRefRecord, PayoutTransfer, PlatformInvoice, PaymentAccount, PaymentIntent, PaymentSettings } from '../../src/modules/payments/types.js';

type Doc = Record<string, unknown> & { PK: string; SK: string; version?: number };

/**
 * Bellek ici odeme deposu. Belgeler sahte finans deposunun `docs` haritasini paylasir: boylece
 * `postBatch.replaceRecords` ile yazilan niyet durumu burada da gorunur (gercek tablodaki gibi).
 */
export function createFakePaymentsRepo(docs: Map<string, Doc>) {
  const key = (d: { PK: string; SK: string }) => `${d.PK}|${d.SK}`;
  let failNextUpdate = false;

  const repo: PaymentsRepository = {
    getIntent: async (apt, id) => docs.get(`APT#${apt}|PI#${id}`) as PaymentIntent | undefined,
    createIntent: async (intent, k, ref) => {
      if (docs.has(key(intent)) || docs.has(key(k)) || (ref && docs.has(key(ref)))) throw new PaymentsConflictError();
      docs.set(key(k), { ...k });
      if (ref) docs.set(key(ref), { ...ref } as unknown as Doc);
      docs.set(key(intent), structuredClone(intent) as unknown as Doc);
    },
    getIntentRef: async (provider, reference) => docs.get(`PAYREF#${provider}#${reference}|PAYREF`) as IntentRefRecord | undefined,
    getIntentKey: async (apt, userId, idem) =>
      docs.get(`APT#${apt}|PIKEY#${userId}#${idem}`) as IntentKeyRecord | undefined,
    updateIntent: async (intent, expectedVersion) => {
      if (intent.version !== expectedVersion + 1) throw new Error('surum');
      if (failNextUpdate) {
        failNextUpdate = false;
        throw new PaymentsConflictError();
      }
      const cur = docs.get(key(intent));
      if (!cur || cur.version !== expectedVersion) throw new PaymentsConflictError();
      docs.set(key(intent), structuredClone(toStoredIntent(intent)) as unknown as Doc);
    },
    listReviewQueue: async (limit) =>
      ([...docs.values()]
        .filter((d) => d.GSI1PK === REVIEW_QUEUE_PK)
        .sort((a, b) => String(a.GSI1SK).localeCompare(String(b.GSI1SK)))
        .slice(0, limit) as unknown as PaymentIntent[]),
    listIntentsBetween: async (apt, from, to) =>
      [...docs.values()]
        .filter((d) => d.PK === `APT#${apt}` && d.SK >= `PI#${from}` && d.SK <= `PI#${to}`)
        .sort((a, b) => a.SK.localeCompare(b.SK)) as unknown as PaymentIntent[],
    listIntents: async (apt, q) => {
      const all = [...docs.values()]
        .filter((d) => d.PK === `APT#${apt}` && d.SK.startsWith('PI#') && (!q.status || d.status === q.status))
        .sort((a, b) => b.SK.localeCompare(a.SK)) as unknown as PaymentIntent[];
      const start = q.cursor ? Number(q.cursor) : 0;
      const end = start + q.limit;
      return { items: all.slice(start, end), cursor: end < all.length ? String(end) : undefined };
    },
    getAccount: async (apt, provider) => docs.get(`APT#${apt}|PAYACCT#${provider}`) as PaymentAccount | undefined,
    putAccount: async (account, expectedVersion) => {
      const cur = docs.get(key(account));
      if (expectedVersion === undefined ? cur : cur?.version !== expectedVersion) throw new PaymentsConflictError();
      docs.set(key(account), { ...account } as unknown as Doc);
    },
    createPayout: async (payout, ref) => {
      if (docs.has(key(payout)) || docs.has(key(ref))) throw new PaymentsConflictError();
      docs.set(key(payout), structuredClone(toStoredPayout(payout)) as unknown as Doc);
      docs.set(key(ref), { ...ref } as unknown as Doc);
    },
    updatePayout: async (payout, expectedVersion, ref) => {
      if (payout.version !== expectedVersion + 1) throw new Error('surum');
      const cur = docs.get(key(payout));
      if (!cur || cur.version !== expectedVersion || (ref && docs.has(key(ref)))) throw new PaymentsConflictError();
      docs.set(key(payout), structuredClone(toStoredPayout(payout)) as unknown as Doc);
      if (ref) docs.set(key(ref), { ...ref } as unknown as Doc);
    },
    getPayout: async (apt, id) => {
      const d = docs.get(`APT#${apt}|PAYOUT#${id}`);
      if (!d) return undefined;
      const { GSI1PK: _a, GSI1SK: _b, ...rest } = structuredClone(d);
      return rest as unknown as PayoutTransfer;
    },
    getPayoutRef: async (provider, reference) => docs.get(`PAYOUTREF#${provider}#${reference}|PAYOUTREF`) as PayoutRefRecord | undefined,
    listPayoutsSince: async (from) =>
      [...docs.values()]
        .filter((d) => d.GSI1PK === PAYOUT_INDEX_PK && String(d.GSI1SK) >= from)
        .sort((a, b) => String(a.GSI1SK).localeCompare(String(b.GSI1SK)))
        .map((d) => {
          const { GSI1PK: _a, GSI1SK: _b, ...rest } = structuredClone(d);
          return rest as unknown as PayoutTransfer;
        }),
    getInvoice: async (apt, id) => docs.get(`APT#${apt}|PINV#${id}`) as PlatformInvoice | undefined,
    putInvoice: async (invoice, expectedVersion) => {
      const cur = docs.get(key(invoice));
      if (expectedVersion === undefined ? cur : cur?.version !== expectedVersion) throw new PaymentsConflictError();
      docs.set(key(invoice), structuredClone(invoice) as unknown as Doc);
    },
    listInvoices: async (apt) =>
      [...docs.values()].filter((d) => d.PK === `APT#${apt}` && d.SK.startsWith('PINV#')).map((d) => structuredClone(d) as unknown as PlatformInvoice),
    getSettings: async (apt) => docs.get(`APT#${apt}|PAYSETTINGS`) as PaymentSettings | undefined,
    putSettings: async (settings, expectedVersion) => {
      const cur = docs.get(key(settings));
      if (expectedVersion === undefined ? cur : cur?.version !== expectedVersion) throw new PaymentsConflictError();
      docs.set(key(settings), { ...settings } as unknown as Doc);
    },
  };

  const intents = () =>
    [...docs.values()].filter((d) => d.entityType === 'PAYMENT_INTENT') as unknown as PaymentIntent[];

  return {
    repo,
    intents,
    failNextUpdate: () => {
      failNextUpdate = true;
    },
  };
}
