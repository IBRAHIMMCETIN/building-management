import { InvalidOutboxRecordError, eventFromOutboxItem } from './outbox.js';
import type { OutboxStore, PendingCursor } from './outboxStore.js';
import type { DomainEvent, EventPublisher } from './publisher.js';
import { relayEvents } from './relay.js';

/**
 * Outbox suprucusu (`outbox_sweep`, 5 dakikada bir).
 *
 * Normalde relay (DynamoDB Streams) olaylari saniyeler icinde yayinlar ve kaydi bekleyen
 * dizinden (GSI1 `OUTBOX#PENDING`) cikarir. Suprucu, `minAgeSeconds`'tan eski olup hala
 * bekleyen kayitlari bulur ve AYNI cekirdekle (`relayEvents`) yeniden yayinlar. Boylece:
 *  - relay'in tekrar denemeleri tukenmis (DLQ) veya kayit yasi asilmis kayitlar,
 *  - stream'in 24 saatlik saklama suresini asan kesintide hic islenmemis kayitlar,
 *  - Streams'in acilmasindan once yazilmis kayitlar
 * kaybolmaz. Esik, relay'in kendi tekrar denemesiyle yarisi azaltir; yine de ayni olay iki kez
 * yayinlanabilir (en az bir kez teslim; tuketiciler `eventId` ile idempotent).
 *
 * Bir kaydin hatasi digerlerini bekletmez (durdurmasiz). Bozuk kayit yayinlanmaz, sayilir ve
 * loglanir (bekleyen kalir; alarm/inceleme icin gorunur).
 */

export type SweepDeps = {
  store: Pick<OutboxStore, 'listPendingPage' | 'markPublished'>;
  publisher: EventPublisher;
  now: () => Date;
  log: Pick<Console, 'info' | 'error'>;
};

export type SweepOptions = {
  /** Bu yastan genc kayitlara dokunulmaz (relay'e birakilir). Varsayilan 120 sn. */
  minAgeSeconds?: number;
  /** Sayfa boyu (varsayilan 100) ve tur basina en fazla sayfa (varsayilan 10). */
  pageSize?: number;
  maxPages?: number;
};

export type SweepResult = {
  /** Esigi asmis bekleyen kayit sayisi (bu turda gorulen). */
  stale: number;
  published: number;
  failed: number;
  invalid: number;
  /** Sayfa siniri yuzunden tamamlanamadi; kalanlar sonraki turda. */
  truncated: boolean;
  /** En eski bekleyen kaydin yasi (sn); yoksa 0. */
  oldestAgeSeconds: number;
};

export const DEFAULT_SWEEP_MIN_AGE_SECONDS = 120;

export async function sweepOutbox(deps: SweepDeps, options: SweepOptions = {}): Promise<SweepResult> {
  const minAge = options.minAgeSeconds ?? DEFAULT_SWEEP_MIN_AGE_SECONDS;
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 10;
  const startedAt = deps.now();
  const olderThan = new Date(startedAt.getTime() - minAge * 1000);

  const result: SweepResult = { stale: 0, published: 0, failed: 0, invalid: 0, truncated: false, oldestAgeSeconds: 0 };
  let cursor: PendingCursor | undefined;
  let pages = 0;
  do {
    const page = await deps.store.listPendingPage({ limit: pageSize, olderThan, ...(cursor ? { cursor } : {}) });
    cursor = page.cursor;
    pages++;

    const batch: { key: string; event: DomainEvent }[] = [];
    for (const item of page.items) {
      result.stale++;
      if (result.oldestAgeSeconds === 0 && item.createdAt) {
        result.oldestAgeSeconds = Math.max(0, Math.round((startedAt.getTime() - Date.parse(item.createdAt)) / 1000));
      }
      try {
        batch.push({ key: item.eventId, event: eventFromOutboxItem(item) });
      } catch (err) {
        if (!(err instanceof InvalidOutboxRecordError)) throw err;
        result.invalid++;
        deps.log.error(JSON.stringify({ level: 'error', msg: 'outbox_record_invalid', source: 'sweep', eventId: item.eventId, apartmentId: item.apartmentId, reason: err.message }));
      }
    }
    const outcome = await relayEvents(batch, deps);
    result.published += outcome.published.length;
    result.failed += outcome.failed.length;
  } while (cursor && pages < maxPages);

  result.truncated = Boolean(cursor);
  return result;
}
