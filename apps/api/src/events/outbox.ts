import { KEY_SEPARATOR, skKey, tenantPk } from '../config/dynamodb.js';
import type { TableKeys } from '../modules/core/types.js';
import { type DomainEvent, type EventType, EVENT_TYPES } from './publisher.js';

/**
 * Transactional outbox.
 *
 * Domain olayi, onu doguran defter/belge yazimiyla AYNI `TransactWriteItems` icinde bir
 * `OUTBOX#<eventId>` kaydi olarak yazilir: yazim basariliysa olay kalici olarak vardir, yazim
 * basarisizsa olay da yoktur ("yazildi ama yayinlanmadi" penceresi kapanir). Yayini ayri bir
 * relay (DynamoDB Streams -> `outbox-relay` Lambda) ve kacan kayitlar icin suprucu
 * (`outbox_sweep`) yapar.
 *
 * Kayit duzeni:
 *   PK     = `APT#<apartmentId>`
 *   SK     = `OUTBOX#<eventId>`            (eventId deterministik; ayni olay iki kez yazilamaz)
 *   GSI1PK = `OUTBOX#PENDING`              (seyrek: yalnizca yayinlanmamis kayitlarda bulunur)
 *   GSI1SK = `<createdAt>#<apartmentId>#<eventId>` (zamana gore; suprucu eski kayitlari tarar)
 *   status = `pending` -> `published`      (outbox defter degildir; relay gunceller)
 *   ttl    = YOK; yalnizca yayinlandiktan sonra eklenir (yayinlanmamis olay asla silinmez).
 */

export const OUTBOX_PREFIX = 'OUTBOX';
export const OUTBOX_PENDING_PK = `${OUTBOX_PREFIX}${KEY_SEPARATOR}PENDING`;

export type OutboxStatus = 'pending' | 'published';

export type OutboxItem = TableKeys & {
  entityType: 'OUTBOX_EVENT';
  eventId: string;
  eventType: EventType;
  apartmentId: string;
  status: OutboxStatus;
  /** Yayinlanacak olay zarfi (SNS mesaji olarak birebir gonderilir). */
  event: DomainEvent;
  createdAt: string;
  GSI1PK?: string;
  GSI1SK?: string;
  publishedAt?: string;
  ttl?: number;
};

export const outboxKeys = (apartmentId: string, eventId: string): TableKeys => ({
  PK: tenantPk(apartmentId),
  SK: skKey(OUTBOX_PREFIX, eventId),
});

/** Bir olay kimligi SK parcasi olarak gecerli mi (bos degil, `#` icermez, makul uzunlukta). */
export function assertEventId(eventId: string): void {
  if (!eventId || eventId.includes(KEY_SEPARATOR) || eventId.length > 512) {
    throw new Error(`Gecersiz eventId: ${JSON.stringify(eventId)}`);
  }
}

/**
 * Olaydan outbox kaydi uretir. `apartmentId` verilirse olayin tenant'i ile eslesmesi zorunludur
 * (bir apartmanin yazimina baska apartmanin olayi karisamaz).
 */
export function toOutboxItem(event: DomainEvent, createdAt: string, apartmentId = event.apartmentId): OutboxItem {
  assertEventId(event.eventId);
  if (event.apartmentId !== apartmentId) {
    throw new Error(`Olay tenant'i yazimla uyusmuyor: ${event.apartmentId} != ${apartmentId}`);
  }
  if (!(EVENT_TYPES as readonly string[]).includes(event.type)) {
    throw new Error(`Bilinmeyen olay turu: ${event.type}`);
  }
  return {
    ...outboxKeys(apartmentId, event.eventId),
    entityType: 'OUTBOX_EVENT',
    eventId: event.eventId,
    eventType: event.type,
    apartmentId,
    status: 'pending',
    event,
    createdAt,
    GSI1PK: OUTBOX_PENDING_PK,
    GSI1SK: [createdAt, apartmentId, event.eventId].join(KEY_SEPARATOR),
  };
}

/** Bir yazimdaki olaylar: kimlikler tekil olmali. */
export function toOutboxItems(events: readonly DomainEvent[], createdAt: string, apartmentId: string): OutboxItem[] {
  const seen = new Set<string>();
  return events.map((event) => {
    if (seen.has(event.eventId)) throw new Error(`Ayni olay iki kez verildi: ${event.eventId}`);
    seen.add(event.eventId);
    return toOutboxItem(event, createdAt, apartmentId);
  });
}
