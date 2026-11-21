import type { OutboxItem } from '../../src/events/outbox.js';
import type { OutboxStore } from '../../src/events/outboxStore.js';

/**
 * Bellek ici outbox deposu: DynamoDB davranisini taklit eder (yalnizca `pending` kayit
 * isaretlenir; seyrek GSI'dan duser; sayfa imleci ANAHTAR tabanli, yani isaretlenip listeden
 * dusen kayitlar sonraki sayfayi kaydirmaz).
 */
export function memoryStore(): OutboxStore & { items: Map<string, OutboxItem> } {
  const items = new Map<string, OutboxItem>();
  const store: OutboxStore & { items: Map<string, OutboxItem> } = {
    items,
    async markPublished(_apt, eventId, at) {
      const cur = items.get(eventId);
      if (!cur || cur.status !== 'pending') return 'already';
      const { GSI1PK: _p, GSI1SK: _s, ...rest } = cur;
      items.set(eventId, { ...rest, status: 'published', publishedAt: at.toISOString() });
      return 'updated';
    },
    async listPending(options = {}) {
      return (await store.listPendingPage(options)).items;
    },
    async listPendingPage(options = {}) {
      const after = typeof options.cursor?.GSI1SK === 'string' ? options.cursor.GSI1SK : '';
      const before = options.olderThan?.toISOString();
      const all = [...items.values()]
        .filter((i) => i.GSI1PK === 'OUTBOX#PENDING' && (i.GSI1SK ?? '') > after && (!before || (i.GSI1SK ?? '') < before))
        .sort((a, b) => (a.GSI1SK ?? '').localeCompare(b.GSI1SK ?? ''));
      const limit = options.limit ?? 25;
      const page = all.slice(0, limit);
      const last = page.at(-1);
      return { items: page, ...(all.length > limit && last ? { cursor: { GSI1SK: last.GSI1SK } } : {}) };
    },
  };
  return store;
}
