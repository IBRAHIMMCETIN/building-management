import type { DomainEvent } from '../../src/events/publisher.js';
import type { AuditDraft } from '../../src/modules/audit/log.js';
import { TenderConflictError, type TenderRepository, type TenderWrite } from '../../src/modules/tenders/repository.js';
import type { Tender, TenderComment, TenderIdempotency } from '../../src/modules/tenders/types.js';

type Doc = Record<string, unknown> & { PK: string; SK: string };

/** Bellek ici ihale deposu; kosullar gercek depoyla ayni (surum, idempotency, yorumda durum kontrolu). */
/** `store`: baska bir sahte depoyla (ornegin Finans `docs`) paylasilan tablo (ayni atomik yazim benzetimi). */
export function createFakeTenderRepo(shared?: Map<string, Doc>) {
  const store = shared ?? new Map<string, Doc>();
  const audits: AuditDraft[] = [];
  const writes: TenderWrite[] = [];
  const outbox: DomainEvent[] = [];
  const k = (o: { PK: string; SK: string }) => `${o.PK}|${o.SK}`;
  const get = <T>(key: { PK: string; SK: string }) => {
    const v = store.get(k(key));
    return v ? (structuredClone(v) as unknown as T) : undefined;
  };
  const prefixed = <T>(apt: string, prefix: string) =>
    [...store.values()]
      .filter((i) => i.PK === `APT#${apt}` && i.SK.startsWith(prefix))
      .sort((a, b) => a.SK.localeCompare(b.SK))
      .map((i) => structuredClone(i) as unknown as T);
  /** Yazimdan hemen once calisir (araya giren es zamanli istek benzetimi). */
  let beforeWrite: (() => Promise<void>) | undefined;

  const repo: TenderRepository = {
    get: async (apt, id) => get<Tender>({ PK: `APT#${apt}`, SK: `TENDER#${id}` }),
    list: async (apt) => prefixed<Tender>(apt, 'TENDER#').filter((t) => t.entityType === 'TENDER'),
    listComments: async (apt, id) => prefixed<TenderComment>(apt, `TCMT#${id}#`),
    getIdempotency: async (apt, key) => get<TenderIdempotency>({ PK: `APT#${apt}`, SK: `TIDEM#${key}` }),
    async write(apt, w) {
      const hook = beforeWrite;
      beforeWrite = undefined;
      if (hook) await hook();
      const pk = `APT#${apt}`;
      for (const d of [w.tender?.item, w.comment?.item, w.idempotency, w.hide]) {
        if (d && d.PK !== pk) throw new Error('Kiraci uyusmazligi');
      }
      if (w.idempotency && store.has(k(w.idempotency))) throw new TenderConflictError('duplicate');
      if (w.tender) {
        const cur = store.get(k(w.tender.item)) as { version?: number } | undefined;
        if (w.tender.expectedVersion === 0 ? !!cur : cur?.version !== w.tender.expectedVersion) throw new TenderConflictError('version');
      }
      if (w.comment) {
        const t = store.get(`${pk}|TENDER#${w.comment.item.tenderId}`);
        if (!t || t.status !== w.comment.requireStatus) throw new TenderConflictError('status');
      }
      if ((w.outbox ?? []).some((e) => outbox.some((o) => o.eventId === e.eventId))) throw new TenderConflictError('version');
      if (w.hide) {
        const cur = store.get(k(w.hide));
        if (!cur || cur.hiddenAt) throw new TenderConflictError('version');
      }
      const put = (d: Doc) => store.set(k(d), structuredClone(d));
      if (w.hide) put(w.hide as unknown as Doc);
      if (w.idempotency) put(w.idempotency as unknown as Doc);
      if (w.tender) put(w.tender.item as unknown as Doc);
      if (w.comment) put(w.comment.item as unknown as Doc);
      for (const e of w.outbox ?? []) outbox.push(structuredClone(e));
      if (w.audit) audits.push(w.audit);
      writes.push(structuredClone(w));
    },
  };
  return {
    repo,
    store,
    audits,
    writes,
    outbox,
    beforeNextWrite: (hook: () => Promise<void>) => {
      beforeWrite = hook;
    },
  };
}
