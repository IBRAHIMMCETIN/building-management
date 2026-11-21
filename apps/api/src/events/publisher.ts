import {
  EventBridgeClient,
  PutEventsCommand,
  ResourceNotFoundException as EventBusNotFoundException,
} from '@aws-sdk/client-eventbridge';
import { NotFoundException as SnsNotFoundException, PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { IsoDate, IsoDateTime, Kurus, LiableParty } from '../modules/core/types.js';

/**
 * Faz 3 - Domain olaylari ve soyut olay firlatici.
 *
 * Kurallar:
 *  - Defter/belge yazimindan doguan olaylar dogrudan yayinlanmaz: yazimla AYNI atomik islemde
 *    outbox'a yazilir (`events/outbox.ts`), yayini relay yapar. Yazim yoksa olay da yoktur.
 *  - Yazim icermeyen zamanlanmis olaylar (DUES_REMINDER) dogrudan yayinlanir.
 *  - `eventId` deterministiktir (defter `transactionId`/`batchId` kaynakli): SQS at-least-once
 *    teslimde tuketiciler `eventId` ile idempotent calismalidir.
 *  - Payload'da kisisel veri (ad, telefon, TC no) TASINMAZ; tuketici gerekirse kendisi okur.
 *  - Tutarlar kurus cinsinden tam sayidir.
 */

// ---------------------------------------------------------------------------
// Olay tipleri
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  'DUE_GENERATED',
  'PAYMENT_RECEIVED',
  'ANNOUNCEMENT_PUBLISHED',
  'LATE_FEE_POSTED',
  'DUES_REMINDER',
  'DUES_BATCH_SUMMARY',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type DueGeneratedPayload = {
  mode: 'single' | 'bulk';
  batchId?: string;
  dueDate: IsoDate;
  date: IsoDate;
  description: string;
  liableParty: LiableParty;
  totalAmount: Kurus;
  /** liableParty: kalemin gercek borclu tarafi (bos daire kurali); yoksa ust duzeydeki taraf. */
  items: { unitId: string; amount: Kurus; transactionId: string; liableParty?: LiableParty }[];
};

export type PaymentReceivedPayload = {
  paymentId: string;
  transactionId: string;
  receiptNumber: string;
  unitId: string;
  liableParty: LiableParty;
  amount: Kurus;
  method: string;
  paidAt: IsoDate;
  /** Ayrilan sakin/malik carisine tahsilat: dairenin bugunku sakinlerine bildirim gitmez. */
  receivableAccountId?: string;
};

/**
 * Toplu tahakkukun tamamlandigini bildiren TEK ozet olay (batchId basina). Kalem olaylari
 * (`DUE_GENERATED`, mode=bulk) kayipsizlik icin yine yazilir ama bildirim uretmez; sakine
 * bu olaydan kullanici bazinda tek ozet gider. Cok buyuk sitelerde `part` ile bolunur.
 */
export type DuesBatchSummaryPayload = {
  batchId: string;
  /** 1'den baslar; `parts` toplam parca sayisi. */
  part: number;
  parts: number;
  date: IsoDate;
  dueDate: IsoDate;
  description: string;
  liableParty: LiableParty;
  totalAmount: Kurus;
  items: { unitId: string; amount: Kurus; transactionId: string; liableParty: LiableParty }[];
};

/** Bildirim worker'i sakinlere SMS/push gonderir; govde tasinmaz, worker kaydi okur. */
export type AnnouncementPublishedPayload = {
  announcementId: string;
  title: string;
  /** Bos ise tum apartman. */
  blockIds: string[];
  publishAt: IsoDateTime;
  expiresAt?: IsoDateTime;
};

/** Zamanlanmis gorev: ay basinda kesinlestirilen gecikme tazminatlari. */
export type LateFeePostedPayload = {
  /** Kesinlestirilen donem (YYYY-MM). */
  period: string;
  items: { unitId: string; liableParty: LiableParty; amount: Kurus; transactionId: string }[];
};

export const REMINDER_KINDS = ['upcoming', 'overdue_1', 'overdue_7'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/** Zamanlanmis gorev: vadeden 3 gun once, vade gectikten 1 ve 7 gun sonra hatirlatma. */
export type DuesReminderPayload = {
  /** Hatirlatma gunu (Istanbul). */
  date: IsoDate;
  items: { unitId: string; liableParty: LiableParty; kind: ReminderKind; dueDate: IsoDate; amount: Kurus }[];
};

type PayloadByType = {
  DUE_GENERATED: DueGeneratedPayload;
  PAYMENT_RECEIVED: PaymentReceivedPayload;
  ANNOUNCEMENT_PUBLISHED: AnnouncementPublishedPayload;
  LATE_FEE_POSTED: LateFeePostedPayload;
  DUES_REMINDER: DuesReminderPayload;
  DUES_BATCH_SUMMARY: DuesBatchSummaryPayload;
};

export type DomainEvent<T extends EventType = EventType> = {
  [K in T]: {
    eventId: string;
    type: K;
    /** Sema surumu; payload degisirse artar. */
    version: 1;
    occurredAt: IsoDateTime;
    apartmentId: string;
    /** Islemi yapan kullanici (sub). */
    actorId: string;
    /** Siralama ihtiyaci olan tuketiciler icin (FIFO MessageGroupId). */
    groupKey: string;
    payload: PayloadByType[K];
  };
}[T];

export type NewEvent<T extends EventType = EventType> = {
  [K in T]: Omit<DomainEvent<K>, 'version' | 'occurredAt' | 'groupKey'> &
    Partial<Pick<DomainEvent<K>, 'occurredAt' | 'groupKey'>>;
}[T];

export function buildEvent<T extends EventType>(input: NewEvent<T>, now: () => Date = () => new Date()): DomainEvent<T> {
  return {
    version: 1,
    occurredAt: now().toISOString(),
    groupKey: input.apartmentId,
    ...input,
  } as DomainEvent<T>;
}

// ---------------------------------------------------------------------------
// Soyut arayuz
// ---------------------------------------------------------------------------

export type EventPublisher = {
  /** Olayi yayinlar; altyapi hatasinda `EventPublishError` firlatir. */
  publish(event: DomainEvent): Promise<void>;
};

export class EventPublishError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { cause?: unknown; retryable: boolean }) {
    super(message, { cause: options.cause });
    this.name = 'EventPublishError';
    this.retryable = options.retryable;
  }
}

/**
 * Hata loglanir, cagiran basarisiz sayilmaz. Defter yazimina bagli olaylar icin KULLANILMAZ
 * (onlar outbox'tan yayinlanir); yalnizca kaybi tolere edilebilen, tekrar uretilebilen yayinlar.
 */
export async function publishSafely(
  publisher: EventPublisher,
  event: DomainEvent,
  log: Pick<Console, 'error'> = console,
): Promise<boolean> {
  try {
    await publisher.publish(event);
    return true;
  } catch (err) {
    log.error(
      JSON.stringify({
        level: 'error',
        msg: 'event_publish_failed',
        eventId: event.eventId,
        type: event.type,
        apartmentId: event.apartmentId,
        error: err instanceof Error ? err.name : 'unknown',
      }),
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Yerel / test: bellek ici yayinci (event-emitter benzeri)
// ---------------------------------------------------------------------------

export type EventHandler<T extends EventType = EventType> = (event: DomainEvent<T>) => void | Promise<void>;

export type InMemoryEventPublisher = EventPublisher & {
  /** Yayinlanan tum olaylar (test dogrulamasi icin). */
  readonly published: DomainEvent[];
  /** Belirli olay turune abone olur; abonelikten cikma fonksiyonu doner. */
  subscribe<T extends EventType>(type: T | '*', handler: EventHandler<T>): () => void;
  clear(): void;
};

/**
 * Yerel gelistirme ve testler icin. Abone hatalari yayinciya sizmaz (SNS'teki gibi
 * yayinci tuketiciden bagimsizdir); `onHandlerError` ile raporlanir.
 */
export function createInMemoryEventPublisher(
  options: { onHandlerError?: (err: unknown, event: DomainEvent) => void } = {},
): InMemoryEventPublisher {
  const published: DomainEvent[] = [];
  const handlers = new Map<string, Set<EventHandler<never>>>();

  return {
    published,
    async publish(event) {
      // Gercek tasimadaki gibi kopya: tuketici yayincinin nesnesini degistiremez.
      const copy = structuredClone(event);
      published.push(copy);
      const targets = [...(handlers.get(event.type) ?? []), ...(handlers.get('*') ?? [])];
      const results = await Promise.allSettled(
        targets.map(async (h) => (h as EventHandler)(structuredClone(copy))),
      );
      for (const r of results) {
        if (r.status === 'rejected') options.onHandlerError?.(r.reason, copy);
      }
    },
    subscribe(type, handler) {
      const set = handlers.get(type) ?? new Set();
      set.add(handler as EventHandler<never>);
      handlers.set(type, set);
      return () => set.delete(handler as EventHandler<never>);
    },
    clear() {
      published.length = 0;
    },
  };
}

/** Olay yayini kapali (yalnizca bilincli tercih: EVENTS_MODE=none). */
export const noopEventPublisher: EventPublisher = { publish: async () => {} };

// ---------------------------------------------------------------------------
// AWS SNS
// ---------------------------------------------------------------------------

type Sender<C> = { send(command: C): Promise<unknown> };

export type SnsPublisherConfig = { topicArn: string; region?: string };

/**
 * SNS topic'ine yayinlar. Abonelik filtreleri icin `eventType` ve `apartmentId` mesaj
 * ozniteligi olarak eklenir. FIFO topic'lerde (`.fifo`) MessageGroupId = groupKey,
 * MessageDeduplicationId = eventId kullanilir.
 */
export function createSnsEventPublisher(
  config: SnsPublisherConfig,
  client: Sender<PublishCommand> = new SNSClient(config.region ? { region: config.region } : {}),
): EventPublisher {
  const fifo = config.topicArn.endsWith('.fifo');
  return {
    async publish(event) {
      try {
        await client.send(
          new PublishCommand({
            TopicArn: config.topicArn,
            Message: JSON.stringify(event),
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: event.type },
              apartmentId: { DataType: 'String', StringValue: event.apartmentId },
            },
            ...(fifo ? { MessageGroupId: event.groupKey, MessageDeduplicationId: event.eventId } : {}),
          }),
        );
      } catch (err) {
        throw new EventPublishError(`SNS yayini basarisiz: ${event.type}`, {
          cause: err,
          retryable: !(err instanceof SnsNotFoundException),
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Amazon EventBridge
// ---------------------------------------------------------------------------

export type EventBridgePublisherConfig = { eventBusName: string; source?: string; region?: string };

export const DEFAULT_EVENT_SOURCE = 'building-management.api';

/** EventBridge'e yayinlar; `detail-type` = olay turu. Kurallar SQS hedeflerine yonlendirir. */
export function createEventBridgePublisher(
  config: EventBridgePublisherConfig,
  client: Sender<PutEventsCommand> = new EventBridgeClient(config.region ? { region: config.region } : {}),
): EventPublisher {
  return {
    async publish(event) {
      let out: { FailedEntryCount?: number; Entries?: { ErrorCode?: string }[] } | undefined;
      try {
        out = (await client.send(
          new PutEventsCommand({
            Entries: [
              {
                EventBusName: config.eventBusName,
                Source: config.source ?? DEFAULT_EVENT_SOURCE,
                DetailType: event.type,
                Detail: JSON.stringify(event),
                Time: new Date(event.occurredAt),
              },
            ],
          }),
        )) as typeof out;
      } catch (err) {
        throw new EventPublishError(`EventBridge yayini basarisiz: ${event.type}`, {
          cause: err,
          retryable: !(err instanceof EventBusNotFoundException),
        });
      }
      // PutEvents kismi basarisizligi hata firlatmaz; sonuc ayrica kontrol edilmelidir.
      if (out?.FailedEntryCount) {
        throw new EventPublishError(
          `EventBridge olayi reddetti: ${out.Entries?.[0]?.ErrorCode ?? 'bilinmeyen'}`,
          { retryable: true },
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Ortam degiskenlerinden secim
// ---------------------------------------------------------------------------

/**
 * EVENTS_MODE:
 *  - `sns`: EVENTS_SNS_TOPIC_ARN gerekli.
 *  - `eventbridge`: EVENTS_BUS_NAME gerekli (EVENTS_SOURCE opsiyonel).
 *  - `local`: bellek ici yayinci; production/Lambda ortaminda kullanilamaz.
 *  - `none`: yayin kapali.
 * Verilmezse: production/Lambda'da baslangic hatasi (olaylar sessizce kaybolmasin),
 * diger ortamlarda `local`.
 */
export function createEventPublisherFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'warn' | 'info'> = console,
): EventPublisher {
  const isProd = env.NODE_ENV === 'production' || Boolean(env.AWS_LAMBDA_FUNCTION_NAME);
  const mode = env.EVENTS_MODE ?? (isProd ? undefined : 'local');
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;

  switch (mode) {
    case 'sns': {
      const topicArn = env.EVENTS_SNS_TOPIC_ARN;
      if (!topicArn) throw new Error('EVENTS_MODE=sns icin EVENTS_SNS_TOPIC_ARN gerekli');
      return createSnsEventPublisher({ topicArn, region });
    }
    case 'eventbridge': {
      const eventBusName = env.EVENTS_BUS_NAME;
      if (!eventBusName) throw new Error('EVENTS_MODE=eventbridge icin EVENTS_BUS_NAME gerekli');
      return createEventBridgePublisher({ eventBusName, source: env.EVENTS_SOURCE, region });
    }
    case 'local': {
      if (isProd) throw new Error('EVENTS_MODE=local production/Lambda ortaminda kullanilamaz');
      const publisher = createInMemoryEventPublisher({
        onHandlerError: (err, event) => log.warn(`Yerel olay isleyici hatasi (${event.type}): ${String(err)}`),
      });
      publisher.subscribe('*', (event) => {
        log.info(`[event] ${event.type} ${event.eventId} apt=${event.apartmentId}`);
      });
      return publisher;
    }
    case 'none':
      return noopEventPublisher;
    case undefined:
      throw new Error('EVENTS_MODE production ortaminda zorunludur (sns | eventbridge | none)');
    default:
      throw new Error(`Gecersiz EVENTS_MODE: ${mode} (sns | eventbridge | local | none)`);
  }
}
