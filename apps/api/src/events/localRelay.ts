import type { OutboxStore } from './outboxStore.js';
import type { EventPublisher } from './publisher.js';
import { relayEvents } from './relay.js';

/**
 * Yerel gelistirme icin bellek ici relay (Node sunucusu, `server.ts`).
 *
 * Yerelde DynamoDB Streams + relay Lambda'si yoktur; bu yoklayici bekleyen outbox kayitlarini
 * (GSI1 `OUTBOX#PENDING`) belirli araliklarla okuyup AWS relay'i ile AYNI cekirdekle
 * (`relayEvents`) yerel yayinciya iletir ve `published` isaretler. Production/Lambda'da
 * kullanilmaz.
 */

export type LocalRelayOptions = {
  store: Pick<OutboxStore, 'listPending' | 'markPublished'>;
  publisher: EventPublisher;
  intervalMs?: number;
  batchSize?: number;
  now?: () => Date;
  log?: Pick<Console, 'info' | 'error' | 'warn'>;
};

export type LocalRelay = {
  /** Tek tur: bekleyenleri yayinlar; yayinlanan sayisini doner. */
  tick(): Promise<number>;
  stop(): void;
};

export function createLocalOutboxRelay(options: LocalRelayOptions): LocalRelay {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? console;
  const batchSize = options.batchSize ?? 25;
  let running = false;

  async function tick(): Promise<number> {
    // Tur cakismasi yok: onceki tur bitmeden yenisi baslamaz.
    if (running) return 0;
    running = true;
    try {
      const pending = await options.store.listPending({ limit: batchSize });
      const outcome = await relayEvents(
        pending.map((item) => ({ key: item.eventId, event: item.event })),
        { publisher: options.publisher, store: options.store, now, log },
      );
      return outcome.published.length;
    } catch (err) {
      log.warn(`Yerel outbox relay turu basarisiz: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    } finally {
      running = false;
    }
  }

  return { tick, stop: () => {} };
}

/** Periyodik calistirir; surecin kapanmasini engellemez (`unref`). */
export function startLocalOutboxRelay(options: LocalRelayOptions): LocalRelay {
  const relay = createLocalOutboxRelay(options);
  const timer = setInterval(() => void relay.tick(), options.intervalMs ?? 2000);
  timer.unref();
  return { tick: relay.tick, stop: () => clearInterval(timer) };
}
