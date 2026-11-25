import type { DomainEvent } from '../../src/events/publisher.js';
import type { AuditDraft } from '../../src/modules/audit/log.js';
import { TicketConflictError, type TicketIdempotency, type TicketRepository } from '../../src/modules/tickets/repository.js';
import type { Ticket, TicketEvent, TicketIndex } from '../../src/modules/tickets/types.js';

/** Bellek ici talep deposu; kosullar gercek depoyla ayni (surum, sayac, idempotency, olay tekilligi). */
export function createFakeTicketRepo() {
  const items = new Map<string, Record<string, unknown> & { PK: string; SK: string }>();
  const audits: AuditDraft[] = [];
  const outbox: DomainEvent[] = [];
  const k = (o: { PK: string; SK: string }) => `${o.PK}|${o.SK}`;
  const byPrefix = <T>(apt: string, prefix: string) =>
    [...items.values()]
      .filter((i) => i.PK === `APT#${apt}` && i.SK.startsWith(prefix))
      .sort((a, b) => a.SK.localeCompare(b.SK))
      .map((i) => structuredClone(i) as unknown as T);
  let failNext: TicketConflictError | undefined;

  const repo: TicketRepository = {
    get: async (apt, id) => {
      const t = items.get(`APT#${apt}|TICKET#${id}`);
      return t ? (structuredClone(t) as unknown as Ticket) : undefined;
    },
    list: async (apt) => byPrefix<Ticket>(apt, 'TICKET#'),
    getMany: async (apt, ids) => (await repo.list(apt)).filter((t) => ids.includes(t.ticketId)),
    listIndexed: async (apt, prefix) => byPrefix<TicketIndex>(apt, prefix).map((i) => i.ticketId),
    listEvents: async (apt, id) => byPrefix<TicketEvent>(apt, `TKEV#${id}#`),
    getIdempotency: async (apt, key) => items.get(`APT#${apt}|TKIDEM#${key}`) as unknown as TicketIdempotency | undefined,
    getCounter: async (apt) => (items.get(`APT#${apt}|CTR#ticket`)?.value as number | undefined) ?? 0,
    async write(apt, w) {
      if (failNext) {
        const e = failNext;
        failNext = undefined;
        throw e;
      }
      if (w.idempotency && items.has(k(w.idempotency))) throw new TicketConflictError('duplicate');
      if (w.ticket) {
        const cur = items.get(k(w.ticket)) as { version?: number } | undefined;
        const expected = w.expectedVersion ?? 0;
        if (expected === 0 ? !!cur : cur?.version !== expected) throw new TicketConflictError('version');
      } else if (w.exists && !items.has(k(w.exists))) throw new TicketConflictError('version');
      if (w.counter) {
        const cur = (items.get(`APT#${apt}|CTR#ticket`)?.value as number | undefined) ?? 0;
        if (cur !== w.counter.expected) throw new TicketConflictError('counter');
      }
      for (const e of w.events ?? []) if (items.has(k(e))) throw new TicketConflictError('version');
      if (w.idempotency) items.set(k(w.idempotency), structuredClone(w.idempotency));
      if (w.ticket) items.set(k(w.ticket), structuredClone(w.ticket) as never);
      if (w.counter) items.set(`APT#${apt}|CTR#ticket`, { PK: `APT#${apt}`, SK: 'CTR#ticket', value: w.counter.expected + 1 });
      for (const e of w.events ?? []) items.set(k(e), structuredClone(e) as never);
      for (const i of w.putIndexes ?? []) items.set(k(i), structuredClone(i) as never);
      if (w.audit) audits.push(w.audit);
      outbox.push(...(w.outbox ?? []));
    },
  };
  return {
    repo,
    items,
    audits,
    outbox,
    /** Bir sonraki yazimi verilen catisma ile basarisiz kilar (yaris testi). */
    failNextWith: (e: TicketConflictError) => {
      failNext = e;
    },
  };
}
