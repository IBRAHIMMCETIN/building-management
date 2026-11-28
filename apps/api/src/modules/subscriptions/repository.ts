import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, QueryCommand, type QueryCommandOutput, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { DataAccessError, getDynamo, getTenantItem, queryTenantAll, tenantPk, toDataAccessError } from '../../config/dynamodb.js';
import type { SiteFeatureSettings } from '../features/catalog.js';
import { toOutboxItems } from '../../events/outbox.js';
import type { DomainEvent } from '../../events/publisher.js';
import { type AuditDraft, sendWithAudits } from '../audit/log.js';
import {
  type BillingSettings,
  type BillingSettingsView,
  DEFAULT_BILLING_SETTINGS,
  PLAN_CATALOG_PK,
  type PlanHead,
  type PlanVersion,
  SUBSCRIPTIONS_PK,
  SUBSCRIPTION_INVOICES_PK,
  type Subscription,
  type SubscriptionInvoice,
  counterKeys,
  formatInvoiceNumber,
  invoiceKeys,
  billingSettingsKeys,
  planKeys,
  subscriptionKeys,
} from './types.js';

const settingsView = (item: Partial<BillingSettings> | undefined): BillingSettingsView =>
  item?.entityType === 'SUBSCRIPTION_SETTINGS'
    ? { enabled: item.enabled === true, automation: item.automation === true, version: item.version ?? 0, ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}) }
    : { ...DEFAULT_BILLING_SETTINGS };

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/** Numarasi henuz verilmemis fatura (numara atomik yazimda, seri sayacindan). */
export type UnnumberedInvoice = Omit<SubscriptionInvoice, 'invoiceNumber'>;

/**
 * Abonelik yazimi: abonelik + yeni faturalar (numaralanir) + guncellenen faturalar + outbox + denetim
 * TEK `TransactWriteItems`. Herhangi bir kosul tutmazsa hicbiri yazilmaz (`DataAccessError('conflict')`).
 */
export type SubscriptionCommit = {
  apartmentId: string;
  subscription?: { item: Subscription; expectedVersion: number | null };
  newInvoices?: UnnumberedInvoice[];
  updatedInvoices?: { item: SubscriptionInvoice; expectedVersion: number }[];
  /** Numaralanmis yeni faturalarla olaylari uretir (fatura olayi numarayi tasir). */
  events?: (numbered: SubscriptionInvoice[]) => DomainEvent[];
  audits: AuditDraft[];
  createdAt: string;
};

export type InvoicePage = { items: SubscriptionInvoice[]; nextCursor?: string };

export type SubscriptionRepository = {
  /** Platform ayari (kayit yoksa varsayilan: kapali). */
  getSettings(): Promise<BillingSettingsView>;
  /** `expectedVersion: 0` ilk kayit. */
  saveSettings(item: BillingSettings, expectedVersion: number, audit: AuditDraft): Promise<void>;
  getPlan(code: string): Promise<PlanHead | undefined>;
  listPlans(): Promise<PlanHead[]>;
  listPlanVersions(code: string): Promise<PlanVersion[]>;
  /** Yeni plan: bas + ilk surum (kosul: kod yok). */
  createPlan(head: PlanHead, version: PlanVersion, audit: AuditDraft): Promise<void>;
  /** Bas kaydi (surum kosullu) + varsa yeni icerik surumu. */
  savePlan(head: PlanHead, expectedVersion: number, version: PlanVersion | undefined, audit: AuditDraft): Promise<void>;

  getSubscription(apartmentId: string): Promise<Subscription | undefined>;
  /** Hizli okuma (yetki kontrolu; tutarli okuma degil). */
  peekSubscription(apartmentId: string): Promise<Subscription | undefined>;
  /** Sitenin Adim 1 ozellik ayari (bildirim worker'i: `channels.push`); site yoksa undefined. */
  peekSiteFeatures(apartmentId: string): Promise<SiteFeatureSettings | undefined>;
  listSubscriptions(): Promise<Subscription[]>;
  getInvoice(apartmentId: string, invoiceId: string): Promise<SubscriptionInvoice | undefined>;
  listInvoices(apartmentId: string): Promise<SubscriptionInvoice[]>;
  listAllInvoices(options: { limit: number; cursor?: string }): Promise<InvoicePage>;
  commit(change: SubscriptionCommit): Promise<{ invoices: SubscriptionInvoice[] }>;
};

const MAX_NUMBERING_ATTEMPTS = 4;

/**
 * Her istekte / her bildirimde yapilan yetki okumalari (ayar, abonelik, site anahtarlari) icin
 * SDK istek zaman asimi: yavas tablo API'yi bekletmesin (hata okuyucunun yedek davranisina duser).
 */
export const HOT_READ_TIMEOUT_MS = 1_500;
const readOptions = () => ({ abortSignal: AbortSignal.timeout(HOT_READ_TIMEOUT_MS) });

function conditionFailed(err: unknown): boolean {
  return err instanceof TransactionCanceledException && (err.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed');
}

async function queryIndex<T>(pk: string, options: { forward?: boolean; limit?: number; cursor?: Record<string, unknown>; max?: number } = {}) {
  const { client, tableName } = getDynamo();
  const items: T[] = [];
  let startKey: QueryCommandOutput['LastEvaluatedKey'] = options.cursor;
  try {
    do {
      const out: QueryCommandOutput = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': pk },
          ScanIndexForward: options.forward ?? true,
          ...(options.limit ? { Limit: options.limit } : {}),
          ExclusiveStartKey: startKey,
        }),
      );
      items.push(...((out.Items ?? []) as T[]));
      startKey = out.LastEvaluatedKey;
      if (options.limit) break;
    } while (startKey && items.length < (options.max ?? 5000));
  } catch (err) {
    throw toDataAccessError(err);
  }
  return { items, lastKey: startKey };
}

const encodeCursor = (key: Record<string, unknown> | undefined) => (key ? Buffer.from(JSON.stringify(key)).toString('base64url') : undefined);
function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Yillik seri sayaclari: yil -> son numara (yoksa 0). */
async function readCounters(years: string[]): Promise<Map<string, number>> {
  const { client, tableName } = getDynamo();
  const out = new Map<string, number>();
  for (const y of years) {
    try {
      const r = await client.send(new GetCommand({ TableName: tableName, Key: counterKeys(y), ConsistentRead: true }));
      out.set(y, typeof r.Item?.seq === 'number' ? r.Item.seq : 0);
    } catch (err) {
      throw toDataAccessError(err);
    }
  }
  return out;
}

/** Faturalara seri numarasi (yil bazli, bosluksuz) ve sayac guncellemeleri. */
export function numberInvoices(invoices: readonly UnnumberedInvoice[], counters: ReadonlyMap<string, number>) {
  const next = new Map(counters);
  const numbered: SubscriptionInvoice[] = invoices.map((inv) => {
    const year = inv.issueDate.slice(0, 4);
    const seq = (next.get(year) ?? 0) + 1;
    next.set(year, seq);
    return { ...inv, invoiceNumber: formatInvoiceNumber(year, seq) } as SubscriptionInvoice;
  });
  const updates = [...next].filter(([y, seq]) => seq !== (counters.get(y) ?? 0)).map(([year, seq]) => ({ year, from: counters.get(year) ?? 0, to: seq }));
  return { numbered, updates };
}

export function createSubscriptionRepository(): SubscriptionRepository {
  return {
    async getSettings() {
      const { client, tableName } = getDynamo();
      try {
        const out = await client.send(new GetCommand({ TableName: tableName, Key: billingSettingsKeys }), readOptions());
        return settingsView(out?.Item as BillingSettings | undefined);
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    async saveSettings(item, expectedVersion, audit) {
      const { client, tableName } = getDynamo();
      const put: TransactItem =
        expectedVersion === 0
          ? { Put: { TableName: tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } }
          : {
              Put: {
                TableName: tableName,
                Item: item,
                ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: { ':expected': expectedVersion },
              },
            };
      try {
        await sendWithAudits(client, [put], [audit]);
      } catch (err) {
        if (conditionFailed(err)) throw new DataAccessError('conflict', 'Ayar başka biri tarafından güncellendi (sürüm uyuşmazlığı)', { cause: err });
        throw toDataAccessError(err);
      }
    },
    getPlan: (code) => getTenantItem<PlanHead>(planKeys.head(code)),
    async listPlans() {
      const { items } = await queryIndex<PlanHead>(PLAN_CATALOG_PK);
      return items.filter((p) => p.entityType === 'PLAN');
    },
    async listPlanVersions(code) {
      const { client, tableName } = getDynamo();
      try {
        const out = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
            ExpressionAttributeValues: { ':pk': planKeys.head(code).PK, ':sk': 'VERSION#' },
            ScanIndexForward: false,
            ConsistentRead: true,
          }),
        );
        return ((out.Items ?? []) as PlanVersion[]).filter((v) => v.entityType === 'PLAN_VERSION');
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    async createPlan(head, version, audit) {
      const { client, tableName } = getDynamo();
      try {
        await sendWithAudits(
          client,
          [
            { Put: { TableName: tableName, Item: head, ConditionExpression: 'attribute_not_exists(PK)' } },
            { Put: { TableName: tableName, Item: version, ConditionExpression: 'attribute_not_exists(PK)' } },
          ],
          [audit],
        );
      } catch (err) {
        if (conditionFailed(err)) throw new DataAccessError('conflict', 'Bu kodla bir plan zaten var', { cause: err });
        throw toDataAccessError(err);
      }
    },
    async savePlan(head, expectedVersion, version, audit) {
      const { client, tableName } = getDynamo();
      const items: TransactItem[] = [
        {
          Put: {
            TableName: tableName,
            Item: head,
            ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':expected': expectedVersion },
          },
        },
        ...(version ? [{ Put: { TableName: tableName, Item: version, ConditionExpression: 'attribute_not_exists(PK)' } }] : []),
      ];
      try {
        await sendWithAudits(client, items, [audit]);
      } catch (err) {
        if (conditionFailed(err)) throw new DataAccessError('conflict', 'Plan başka biri tarafından güncellendi (sürüm uyuşmazlığı)', { cause: err });
        throw toDataAccessError(err);
      }
    },

    getSubscription: (apartmentId) => getTenantItem<Subscription>(subscriptionKeys(apartmentId)),
    async peekSubscription(apartmentId) {
      const { client, tableName } = getDynamo();
      try {
        const out = await client.send(new GetCommand({ TableName: tableName, Key: subscriptionKeys(apartmentId) }), readOptions());
        const item = out?.Item as Subscription | undefined;
        return item?.entityType === 'SUBSCRIPTION' ? item : undefined;
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    async peekSiteFeatures(apartmentId) {
      const { client, tableName } = getDynamo();
      try {
        const out = await client.send(new GetCommand({ TableName: tableName, Key: { PK: tenantPk(apartmentId), SK: 'SITE' }, ProjectionExpression: 'settings.features' }), readOptions());
        return (out?.Item as { settings?: { features?: SiteFeatureSettings } } | undefined)?.settings?.features;
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    async listSubscriptions() {
      const { items } = await queryIndex<Subscription>(SUBSCRIPTIONS_PK);
      return items.filter((s) => s.entityType === 'SUBSCRIPTION');
    },
    getInvoice: (apartmentId, invoiceId) => getTenantItem<SubscriptionInvoice>(invoiceKeys(apartmentId, invoiceId)),
    async listInvoices(apartmentId) {
      const items = await queryTenantAll<SubscriptionInvoice>(apartmentId, 'SUBINV#', { ConsistentRead: true });
      return items.filter((i) => i.entityType === 'SUBSCRIPTION_INVOICE' && i.apartmentId === apartmentId);
    },
    async listAllInvoices({ limit, cursor }) {
      const { items, lastKey } = await queryIndex<SubscriptionInvoice>(SUBSCRIPTION_INVOICES_PK, { forward: false, limit, cursor: decodeCursor(cursor) });
      const next = encodeCursor(lastKey);
      return { items: items.filter((i) => i.entityType === 'SUBSCRIPTION_INVOICE'), ...(next ? { nextCursor: next } : {}) };
    },

    async commit(change) {
      const { client, tableName } = getDynamo();
      const newInvoices = change.newInvoices ?? [];
      const years = [...new Set(newInvoices.map((i) => i.issueDate.slice(0, 4)))];
      for (let attempt = 1; ; attempt++) {
        const counters = await readCounters(years);
        const { numbered, updates } = numberInvoices(newInvoices, counters);
        const putNew = (Item: Record<string, unknown>): TransactItem => ({ Put: { TableName: tableName, Item, ConditionExpression: 'attribute_not_exists(PK)' } });
        const versioned = (Item: Record<string, unknown>, expected: number): TransactItem => ({
          Put: {
            TableName: tableName,
            Item,
            ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':expected': expected },
          },
        });
        const counterItems: TransactItem[] = updates.map((u) => ({
          Update: {
            TableName: tableName,
            Key: counterKeys(u.year),
            UpdateExpression: 'SET #seq = :to, entityType = :type',
            ConditionExpression: u.from === 0 ? 'attribute_not_exists(#seq)' : '#seq = :from',
            ExpressionAttributeNames: { '#seq': 'seq' },
            ExpressionAttributeValues: { ':to': u.to, ':type': 'SUBINV_COUNTER', ...(u.from === 0 ? {} : { ':from': u.from }) },
          },
        }));
        const events = change.events?.(numbered) ?? [];
        const items: TransactItem[] = [
          ...(change.subscription
            ? [change.subscription.expectedVersion === null ? putNew(change.subscription.item) : versioned(change.subscription.item, change.subscription.expectedVersion)]
            : []),
          ...numbered.map(putNew),
          ...(change.updatedInvoices ?? []).map((u) => versioned(u.item, u.expectedVersion)),
          ...counterItems,
          ...toOutboxItems(events, change.createdAt, change.apartmentId).map(putNew),
        ];
        try {
          await sendWithAudits(client, items, change.audits);
          return { invoices: numbered };
        } catch (err) {
          if (conditionFailed(err)) {
            // Yalnizca sayac yarisi tekrar denenir (baska apartmanin faturasi ayni anda numara aldi).
            const reasons = err instanceof TransactionCanceledException ? (err.CancellationReasons ?? []) : [];
            const counterStart = (change.subscription ? 1 : 0) + numbered.length + (change.updatedInvoices?.length ?? 0);
            const onlyCounter = reasons.every((r, i) => !r.Code || r.Code === 'None' || (i >= counterStart && i < counterStart + counterItems.length));
            if (onlyCounter && counterItems.length > 0 && attempt < MAX_NUMBERING_ATTEMPTS) continue;
            throw new DataAccessError('conflict', 'Abonelik kaydı başka bir işlemle güncellendi; tekrar deneyin', { cause: err });
          }
          throw toDataAccessError(err);
        }
      }
    },
  };
}

export const subscriptionRepository: SubscriptionRepository = createSubscriptionRepository();

// ---------------------------------------------------------------------------
// Bellek ici depo (testler ve yerel gelistirme)
// ---------------------------------------------------------------------------

export function createMemorySubscriptionRepository(initial: Partial<BillingSettingsView> = { enabled: true, automation: true }) {
  let settings: BillingSettings | undefined =
    initial.enabled !== undefined || initial.automation !== undefined
      ? { ...billingSettingsKeys, entityType: 'SUBSCRIPTION_SETTINGS', enabled: initial.enabled === true, automation: initial.automation === true, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed', version: 1 }
      : undefined;
  const plans = new Map<string, PlanHead>();
  const versions = new Map<string, PlanVersion[]>();
  const subs = new Map<string, Subscription>();
  const invoices = new Map<string, SubscriptionInvoice>();
  const counters = new Map<string, number>();
  const audits: AuditDraft[] = [];
  const events: DomainEvent[] = [];
  const conflict = () => new DataAccessError('conflict', 'Kosul saglanmadi');
  const clone = <T>(v: T): T => structuredClone(v);

  const repo: SubscriptionRepository = {
    getSettings: async () => settingsView(settings),
    async saveSettings(item, expectedVersion, audit) {
      if ((settings?.version ?? 0) !== expectedVersion) throw conflict();
      settings = clone(item);
      audits.push(audit);
    },
    getPlan: async (code) => clone(plans.get(code)),
    listPlans: async () => [...plans.values()].map(clone).sort((a, b) => a.code.localeCompare(b.code)),
    listPlanVersions: async (code) => clone([...(versions.get(code) ?? [])].sort((a, b) => b.planVersion - a.planVersion)),
    async createPlan(head, version, audit) {
      if (plans.has(head.code)) throw conflict();
      plans.set(head.code, clone(head));
      versions.set(head.code, [clone(version)]);
      audits.push(audit);
    },
    async savePlan(head, expectedVersion, version, audit) {
      const cur = plans.get(head.code);
      if (!cur || cur.version !== expectedVersion) throw conflict();
      const list = versions.get(head.code) ?? [];
      if (version && list.some((v) => v.planVersion === version.planVersion)) throw conflict();
      plans.set(head.code, clone(head));
      if (version) versions.set(head.code, [...list, clone(version)]);
      audits.push(audit);
    },
    getSubscription: async (apt) => clone(subs.get(apt)),
    peekSubscription: async (apt) => clone(subs.get(apt)),
    peekSiteFeatures: async () => undefined,
    listSubscriptions: async () => [...subs.values()].map(clone),
    getInvoice: async (apt, id) => clone(invoices.get(`${apt}|${id}`)),
    listInvoices: async (apt) => [...invoices.values()].filter((i) => i.apartmentId === apt).map(clone),
    async listAllInvoices({ limit, cursor }) {
      const all = [...invoices.values()].sort((a, b) => b.GSI1SK.localeCompare(a.GSI1SK));
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + limit).map(clone);
      return { items: page, ...(start + limit < all.length ? { nextCursor: String(start + limit) } : {}) };
    },
    async commit(change) {
      const { numbered, updates } = numberInvoices(change.newInvoices ?? [], counters);
      if (change.subscription) {
        const cur = subs.get(change.apartmentId);
        const exp = change.subscription.expectedVersion;
        if (exp === null ? cur : !cur || cur.version !== exp) throw conflict();
      }
      for (const inv of numbered) if (invoices.has(`${inv.apartmentId}|${inv.invoiceId}`)) throw conflict();
      for (const u of change.updatedInvoices ?? []) {
        const cur = invoices.get(`${u.item.apartmentId}|${u.item.invoiceId}`);
        if (!cur || cur.version !== u.expectedVersion) throw conflict();
      }
      const evs = change.events?.(numbered) ?? [];
      // Outbox anahtari tekil: ayni olay ikinci kez yazilamaz.
      for (const e of evs) if (events.some((x) => x.eventId === e.eventId)) throw conflict();
      if (change.subscription) subs.set(change.apartmentId, clone(change.subscription.item));
      for (const inv of numbered) invoices.set(`${inv.apartmentId}|${inv.invoiceId}`, clone(inv));
      for (const u of change.updatedInvoices ?? []) invoices.set(`${u.item.apartmentId}|${u.item.invoiceId}`, clone(u.item));
      for (const u of updates) counters.set(u.year, u.to);
      events.push(...evs.map(clone));
      audits.push(...change.audits);
      return { invoices: numbered.map(clone) };
    },
  };
  return { repo, plans, versions, subs, invoices, counters, audits, events };
}
