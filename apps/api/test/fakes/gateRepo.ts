import type { AuditDraft } from '../../src/modules/audit/log.js';
import { type GateCondition, GateConflictError, type GateRepository, decodeCursor, encodeCursor } from '../../src/modules/gate/repository.js';

type Item = Record<string, unknown> & { PK: string; SK: string };

/**
 * Bellek ici guvenlik kapisi deposu. Kosullar gercek depoyla birebir (new / match / new_or), yazim
 * atomiktir (once tum kosullar, sonra tum ogeler). Her cagri bir mikro gorev bekler: es zamanli
 * istekler gercekteki gibi araya girer (tek girislik gecis yarisi).
 */
export function createFakeGateRepo() {
  const items = new Map<string, Item>();
  const audits: AuditDraft[] = [];
  const writes: { puts: Item[] }[] = [];
  const k = (pk: string, sk: string) => `${pk}|${sk}`;
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  const holds = (cur: Item | undefined, c: GateCondition) => {
    if (c.kind === 'none') return true;
    if (c.kind === 'new') return !cur;
    const eq = () => Object.entries(c.fields).every(([f, v]) => cur?.[f] === v);
    return c.kind === 'match' ? !!cur && eq() : !cur || eq();
  };

  const repo: GateRepository = {
    async get<T>(apt: string, sk: string) {
      await tick();
      const it = items.get(k(`APT#${apt}`, sk));
      return it ? (structuredClone(it) as T) : undefined;
    },
    async getMany<T>(apt: string, sks: readonly string[]) {
      await tick();
      return [...new Set(sks)].flatMap((sk) => {
        const it = items.get(k(`APT#${apt}`, sk));
        return it ? [structuredClone(it) as T] : [];
      });
    },
    async query<T>(apt: string, q: { prefix?: string; from?: string; to?: string; limit?: number; desc?: boolean; cursor?: string }) {
      await tick();
      const pk = `APT#${apt}`;
      const start = decodeCursor(q.cursor);
      let rows = [...items.values()]
        .filter((i) => i.PK === pk && (q.prefix !== undefined ? i.SK.startsWith(q.prefix) : i.SK >= (q.from ?? '') && i.SK <= (q.to ?? '')))
        .sort((a, b) => (q.desc ? b.SK.localeCompare(a.SK) : a.SK.localeCompare(b.SK)));
      if (start) rows = rows.filter((i) => (q.desc ? i.SK < start : i.SK > start));
      const page = q.limit ? rows.slice(0, q.limit) : rows;
      const more = q.limit !== undefined && rows.length > q.limit;
      const last = page.at(-1);
      return { items: page.map((i) => structuredClone(i) as T), ...(more && last ? { cursor: encodeCursor(last) } : {}) };
    },
    async write(apt, w) {
      await tick();
      const pk = `APT#${apt}`;
      if (w.puts.some((p) => p.item.PK !== pk)) throw new Error('Kiraci uyusmazligi');
      for (const p of w.puts) if (!holds(items.get(k(p.item.PK, p.item.SK)), p.condition)) throw new GateConflictError(p.reason);
      for (const p of w.puts) items.set(k(p.item.PK, p.item.SK), structuredClone(p.item) as Item);
      writes.push({ puts: w.puts.map((p) => structuredClone(p.item) as Item) });
      if (w.audit) audits.push(w.audit);
    },
  };

  /** Bir on ekteki kayitlar (test incelemesi). */
  const byPrefix = (apt: string, prefix: string) => [...items.values()].filter((i) => i.PK === `APT#${apt}` && i.SK.startsWith(prefix)).sort((a, b) => a.SK.localeCompare(b.SK));
  return { repo, items, audits, writes, byPrefix };
}
