import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { OUTBOX_PREFIX, type OutboxItem } from '../events/outbox.js';
import { type OutboxStore, createDynamoOutboxStore } from '../events/outboxStore.js';
import { type DomainEvent, EVENT_TYPES, type EventPublisher, createEventPublisherFromEnv } from '../events/publisher.js';
import { relayEvents } from '../events/relay.js';

/**
 * Outbox relay Lambda'si (Asama 2).
 *
 * Akis: API/zamanlayici defter yazimi + `OUTBOX#<eventId>` kaydi (tek TransactWriteItems)
 *   -> DynamoDB Streams (NEW_IMAGE) -> event source mapping filtresi (yalnizca `OUTBOX#` INSERT)
 *   -> bu Lambda -> SNS olay topic'i -> SQS -> bildirim worker'i.
 *
 * - Kismi toplu hata bildirimi (ReportBatchItemFailures): ilk basarisiz kaydin sira numarasi
 *   doner; Lambda o kayittan itibaren yeniden dener (sira korunur, oncekiler tekrar edilmez).
 * - Tekrar denemeler tukenirse kayit bilgisi SQS DLQ'ya duser (Terraform `outbox.tf`) ve alarm
 *   calar; outbox kaydi `pending` kaldigi icin suprucu (`outbox_sweep`, Asama 3) yeniden yayinlar.
 * - Filtre disinda kalan kayitlar (MODIFY/REMOVE, baska SK) savunma amacli burada da atlanir.
 * - Bozuk kayit (ayristirilamayan olay) parcayi bloklamaz: loglanir ve atlanir; `pending`
 *   kaldigi icin suprucu/alarm gorunur kilar.
 */

// ---------------------------------------------------------------------------
// DynamoDB Streams olay tipleri (yalnizca kullanilan alanlar)
// ---------------------------------------------------------------------------

export type DynamoStreamRecord = {
  eventID?: string;
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE';
  dynamodb?: {
    Keys?: Record<string, AttributeValue>;
    NewImage?: Record<string, AttributeValue>;
    SequenceNumber?: string;
  };
};
export type DynamoStreamEvent = { Records: DynamoStreamRecord[] };
export type StreamBatchResponse = { batchItemFailures: { itemIdentifier: string }[] };

export class InvalidOutboxRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutboxRecordError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Bir outbox kaydindan yayinlanacak olay zarfini cikarir ve tutarliligini dogrular. */
export function eventFromOutboxItem(item: Partial<OutboxItem>): DomainEvent {
  const event = item.event as unknown;
  if (!isObject(event)) throw new InvalidOutboxRecordError('event alani yok');
  if (typeof event.eventId !== 'string' || event.eventId !== item.eventId) {
    throw new InvalidOutboxRecordError('eventId kayitla uyusmuyor');
  }
  if (typeof event.type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(event.type)) {
    throw new InvalidOutboxRecordError('bilinmeyen olay turu');
  }
  if (typeof event.apartmentId !== 'string' || event.apartmentId !== item.apartmentId || item.PK !== `APT#${event.apartmentId}`) {
    throw new InvalidOutboxRecordError('olay tenant\'i kayitla uyusmuyor');
  }
  return event as DomainEvent;
}

const isOutboxInsert = (r: DynamoStreamRecord): boolean => {
  const sk = r.dynamodb?.Keys?.SK ?? r.dynamodb?.NewImage?.SK;
  return r.eventName === 'INSERT' && typeof sk?.S === 'string' && sk.S.startsWith(`${OUTBOX_PREFIX}#`);
};

export type OutboxRelayDeps = {
  publisher: EventPublisher;
  store: Pick<OutboxStore, 'markPublished'>;
  now: () => Date;
  log: Pick<Console, 'info' | 'error'>;
};

export function createOutboxRelay(overrides: Partial<OutboxRelayDeps> = {}) {
  // Ortam degiskenlerinden kurulum ilk cagrida (modul yuklemesi testlerde ortam gerektirmesin).
  const lazy: Partial<OutboxRelayDeps> = {};
  const deps = (): OutboxRelayDeps => ({
    publisher: (lazy.publisher ??= overrides.publisher ?? createEventPublisherFromEnv()),
    store: (lazy.store ??= overrides.store ?? createDynamoOutboxStore()),
    now: overrides.now ?? (() => new Date()),
    log: overrides.log ?? console,
  });

  return async (streamEvent: DynamoStreamEvent): Promise<StreamBatchResponse> => {
    const d = deps();
    const items: { key: string; event: DomainEvent }[] = [];
    for (const record of streamEvent.Records ?? []) {
      if (!isOutboxInsert(record)) continue;
      const seq = record.dynamodb?.SequenceNumber;
      // Sira numarasi olmadan kismi hata bildirilemez: tum parca yeniden denensin.
      if (!seq) throw new InvalidOutboxRecordError('SequenceNumber yok');
      try {
        const image = record.dynamodb?.NewImage;
        if (!image) throw new InvalidOutboxRecordError('NewImage yok (stream_view_type NEW_IMAGE olmali)');
        items.push({ key: seq, event: eventFromOutboxItem(unmarshall(image) as Partial<OutboxItem>) });
      } catch (err) {
        if (!(err instanceof InvalidOutboxRecordError)) throw err;
        d.log.error(JSON.stringify({ level: 'error', msg: 'outbox_record_invalid', eventID: record.eventID, sequenceNumber: seq, reason: err.message }));
      }
    }

    const outcome = await relayEvents(items, d, { stopOnFailure: true });
    const first = outcome.failed[0];
    return { batchItemFailures: first ? [{ itemIdentifier: first.key }] : [] };
  };
}

export const handler = createOutboxRelay();
