import type { OutboxStore } from './outboxStore.js';
import type { DomainEvent, EventPublisher } from './publisher.js';

/**
 * Outbox yayin cekirdegi: AWS relay Lambda'si (DynamoDB Streams), yerel bellek ici relay ve
 * suprucu (`outbox_sweep`) ayni fonksiyonu kullanir.
 *
 * Her olay icin: once yayinla, sonra kaydi `published` isaretle. Teslim garantisi
 * "en az bir kez"dir: yayin basarili ama isaretleme basarisizsa olay yeniden yayinlanabilir;
 * tuketiciler `eventId` ile idempotenttir (bildirim worker'i `NOTIF#<eventId>`, FIFO topic'te
 * `MessageDeduplicationId = eventId`).
 *
 * `stopOnFailure`: akis (stream) islemede sira korunur; ilk hatada durulur, cunku Lambda
 * basarisiz kayittan itibaren tum parcayi yeniden dener (sonrakileri simdi islemek yalnizca
 * tekrar uretir). Suprucu ve yerel relay icin false: bir kaydin hatasi digerlerini bekletmez.
 */

export type RelayDeps = {
  publisher: EventPublisher;
  store: Pick<OutboxStore, 'markPublished'>;
  now: () => Date;
  log: Pick<Console, 'info' | 'error'>;
};

export type RelayOutcome<K> = {
  published: K[];
  /** Ilk basarisizdan itibaren islenmeyen (veya basarisiz olan) kayitlar. */
  failed: { key: K; eventId: string; error: string }[];
};

export async function relayEvents<K>(
  items: readonly { key: K; event: DomainEvent }[],
  deps: RelayDeps,
  options: { stopOnFailure?: boolean } = {},
): Promise<RelayOutcome<K>> {
  const outcome: RelayOutcome<K> = { published: [], failed: [] };
  for (const [i, { key, event }] of items.entries()) {
    try {
      await deps.publisher.publish(event);
      const marked = await deps.store.markPublished(event.apartmentId, event.eventId, deps.now());
      outcome.published.push(key);
      deps.log.info(
        JSON.stringify({ level: 'info', msg: 'outbox_published', eventId: event.eventId, type: event.type, apartmentId: event.apartmentId, marked }),
      );
    } catch (err) {
      const error = err instanceof Error ? err.name : 'unknown';
      deps.log.error(
        JSON.stringify({ level: 'error', msg: 'outbox_publish_failed', eventId: event.eventId, type: event.type, apartmentId: event.apartmentId, error }),
      );
      outcome.failed.push({ key, eventId: event.eventId, error });
      if (options.stopOnFailure) {
        for (const rest of items.slice(i + 1)) {
          outcome.failed.push({ key: rest.key, eventId: rest.event.eventId, error: 'skipped' });
        }
        break;
      }
    }
  }
  return outcome;
}
