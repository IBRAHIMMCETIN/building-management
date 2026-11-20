import { PaymentsConflictError, type PaymentsRepository } from '../../src/modules/payments/repository.js';
import type { IntentKeyRecord, PaymentAccount, PaymentIntent } from '../../src/modules/payments/types.js';

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
    createIntent: async (intent, k) => {
      if (docs.has(key(intent)) || docs.has(key(k))) throw new PaymentsConflictError();
      docs.set(key(k), { ...k });
      docs.set(key(intent), structuredClone(intent) as unknown as Doc);
    },
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
      docs.set(key(intent), structuredClone(intent) as unknown as Doc);
    },
    listIntentsBetween: async (apt, from, to) =>
      [...docs.values()]
        .filter((d) => d.PK === `APT#${apt}` && d.SK >= `PI#${from}` && d.SK <= `PI#${to}`)
        .sort((a, b) => a.SK.localeCompare(b.SK)) as unknown as PaymentIntent[],
    getAccount: async (apt, provider) => docs.get(`APT#${apt}|PAYACCT#${provider}`) as PaymentAccount | undefined,
    putAccount: async (account, expectedVersion) => {
      const cur = docs.get(key(account));
      if (expectedVersion === undefined ? cur : cur?.version !== expectedVersion) throw new PaymentsConflictError();
      docs.set(key(account), { ...account } as unknown as Doc);
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
