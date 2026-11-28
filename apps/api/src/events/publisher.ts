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
  'METER_PERIOD_REVERSED',
  'TICKET_CREATED',
  'TICKET_ASSIGNED',
  'TICKET_STATUS_CHANGED',
  'TICKET_COMMENTED',
  'OPERATIONS_DIGEST',
  'POLL_PUBLISHED',
  'GATE_COURIER_ARRIVED',
  'GATE_GUEST_ENTERED',
  'RESERVATION_APPROVED',
  'RESERVATION_REJECTED',
  'RESERVATION_CANCELLED',
  'ASSEMBLY_CALLED',
  'ASSEMBLY_CANCELLED',
  'ASSEMBLY_RESCHEDULED',
  'TENDER_PUBLISHED',
  'TENDER_DECIDED',
  'TENDER_CANCELLED',
  'TENDER_REPLIED',
  'MEMBERSHIP_ENDED',
  'BULK_JOB_FINISHED',
  'RESTRUCTURE_REQUESTED',
  'RESTRUCTURE_APPROVED',
  'RESTRUCTURE_REJECTED',
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
  items: { unitId: string; amount: Kurus; transactionId: string; liableParty?: LiableParty; userId?: string }[];
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
  /** `userId`: `split` bolumde paydasa ozel kalem (Finans 2.1). */
  items: { unitId: string; amount: Kurus; transactionId: string; liableParty: LiableParty; userId?: string }[];
};

/**
 * Finans 2.3-4: sayac donemi tahakkukunun toplu geri alinmasi. Yalnizca yonetici `notify: true`
 * gonderirse yazilir (varsayilan sessiz). Ayrilan cariye yazilmis kalemler listede yer almaz.
 */
export type MeterPeriodReversedPayload = {
  periodId: string;
  batchId: string;
  description: string;
  totalAmount: Kurus;
  items: { unitId: string; amount: Kurus; transactionId: string; liableParty: LiableParty; userId?: string }[];
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
  /** `userId`: paydas alt carisinin tazminati (Finans 2.1). */
  items: { unitId: string; liableParty: LiableParty; amount: Kurus; transactionId: string; userId?: string }[];
};

/**
 * Finans 2.2: `plan_default` taksit planinda temerrut (muacceliyet) tespiti/uyarisi; `dueDate`
 * geciken ilk taksitin vadesi, `amount` plandaki odenmemis toplam.
 */
export const REMINDER_KINDS = ['upcoming', 'overdue_1', 'overdue_7', 'plan_default'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/** Zamanlanmis gorev: vadeden 3 gun once, vade gectikten 1 ve 7 gun sonra hatirlatma. */
export type DuesReminderPayload = {
  /** Hatirlatma gunu (Istanbul). */
  date: IsoDate;
  /** `userId`: paydas alt carisinin hatirlatmasi (Finans 2.1); yalnizca o paydasa gider. */
  items: { unitId: string; liableParty: LiableParty; kind: ReminderKind; dueDate: IsoDate; amount: Kurus; userId?: string }[];
};

/**
 * Faz 3 (O1-2): ariza / talep olaylari. Govde (aciklama, yorum metni) tasinmaz; alicilar worker'da
 * yetki kurallariyla cozulur (yonetim, gorevli, acan sakin ve dairenin guncel uyeleri). Ic notlar
 * olay uretmez.
 */
export type TicketEventPayload = {
  ticketId: string;
  number: string;
  title: string;
  category: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  location: { kind: 'unit' | 'common'; unitId?: string; blockId?: string; area?: string };
  createdBy: string;
  /** Acanin aktor turu (manager | staff | resident | security). */
  createdByKind: string;
  assigneeId?: string;
  /** Olayi tetikleyenin aktor turu. */
  actorKind: string;
  /** TICKET_STATUS_CHANGED: gecis ve sonuc. */
  action?: string;
  from?: string;
  to?: string;
  closeKind?: string;
  cancelKind?: string;
};

/**
 * Faz 3 (O1-3): gunluk operasyon ozeti (apartman basina gunde en fazla bir; `ticket_maintenance`
 * isi). SLA'si asilmis talepler, yaklasan ve geciken bakim gorevleri, otomatik kapanan talep
 * sayisi. Yonetim tumunu, gorevli yalnizca kendisine atanan ve atanmamis kalemleri alir.
 */
/**
 * Y1: oylama yayinlandi. Secenekler ve aciklama tasinmaz; `owners` oylamasi kat maliklerine,
 * `residents` tum guncel uyelere bildirilir.
 */
export type PollPublishedPayload = {
  pollId: string;
  title: string;
  audience: 'owners' | 'residents';
  opensAt: IsoDateTime;
  closesAt: IsoDateTime;
};

export type OperationsDigestPayload = {
  date: IsoDate;
  slaBreached: { ticketId: string; number: string; title: string; priority: string; dueAt: IsoDateTime; assigneeId?: string }[];
  maintenanceDue: { taskId: string; name: string; dueDate: IsoDate; assigneeId?: string }[];
  maintenanceOverdue: { taskId: string; name: string; dueDate: IsoDate; assigneeId?: string }[];
  autoClosed: number;
  /**
   * v2: ekipman garanti / servis sozlesmesi / periyodik kontrol tarihleri: her gun 30 gun icinde
   * dolacak ve son 30 gunde dolmus olanlar; pazartesi (`equipmentWeekly`) daha once dolmus sozlesme
   * / kontroller de. Yalnizca yonetime gider; liste en fazla 100 kalem, `equipmentTotal` kesilmeden
   * onceki sayi. Eski olaylarda yoktur.
   */
  equipmentExpiring?: { equipmentId: string; name: string; kind: 'warranty' | 'contract' | 'inspection'; date: IsoDate; expired: boolean }[];
  equipmentTotal?: number;
  equipmentWeekly?: boolean;
};

/**
 * Guvenlik kapisi: gorevli bir bolum icin kurye kaydetti. Bolumde OTURAN guncel uyeler portalda
 * onaylar / reddeder (portal 15 sn'de bir yenilemeye devam eder; bildirim ek kanaldir). Firma, not
 * ve kuryeye ait bilgi tasinmaz: worker kurye kaydini okur (yanitlanmis / iptal / suresi dolmus
 * kayit icin bildirim gitmez). KVKK: telefon numarasi hicbir yerde yok.
 */
export type GateCourierArrivedPayload = {
  courierId: string;
  unitId: string;
  /** Yanit icin son an (kayittan `COURIER_RESPONSE_MINUTES` sonra). */
  respondBy: IsoDateTime;
};

/**
 * Misafir gecisiyle giris kaydedildi: gecisi OLUSTURAN sakine (hala bolumde oturuyorsa). Misafir
 * adi, plaka ve not tasinmaz.
 */
export type GateGuestEnteredPayload = {
  passId: string;
  unitId: string;
  /** Gecisi olusturan sakin (alici). */
  hostUserId: string;
  entryMode: 'single' | 'multi';
  /** Bu giris dahil toplam giris sayisi. */
  entryCount: number;
  enteredAt: IsoDateTime;
  validUntil: IsoDate;
};

/**
 * Ortak alan rezervasyonu: yonetimin onayi, reddi veya iptali (sakin kendi iptalinde olay yok;
 * otomatik onay yonetim karari degildir). Alici rezervasyonu yapan sakin (hala dairenin guncel
 * uyesiyse). Ret / iptal gerekcesi ve yonetimin notu serbest metindir: TASINMAZ, worker
 * rezervasyon kaydindan okur; ucret iadesinin guncel durumu da oradan (iptal yazildiktan sonra
 * ters kayit ayri yazimla tamamlanir). `feeStatus` yazim anindaki durumdur (yedek).
 */
export type ReservationDecisionPayload = {
  bookingId: string;
  facilityId: string;
  facilityName: string;
  unitId: string;
  /** Rezervasyonu yapan sakin (alici). */
  bookerId: string;
  date: IsoDate;
  start: IsoDateTime;
  end: IsoDateTime;
  /** Ucret (kurus, tam sayi); 0 = ucretsiz. */
  feeKurus: number;
  feeStatus: string;
};

/**
 * Genel kurul devami: yonetici kat malikleri kurulu cagrisini gonderdi (ilk gonderim veya acik,
 * denetimli yeniden gonderim; `callSeq` 1'den baslar, `eventId` = `ASSEMBLY_CALLED:<id>:<sira>`).
 * Alicilar (cagri anindaki oy listesinde malik olan apartman kullanicilari) `ASMCALL#` kaydindadir:
 * worker kaydi okur, toplanti iptal edilmisse veya baslamissa e-posta gondermez. Toplanti bilgisi
 * (tarih, yer / baglanti, gundem basliklari, ikinci toplanti) cagridaki haliyle tasinir; kisisel
 * veri yok. E-posta nezaketen gonderilir, KMK m.29'daki cagrinin yerine gecmez.
 */
export type AssemblyCalledPayload = {
  assemblyId: string;
  callSeq: number;
  kind: 'ordinary' | 'extraordinary';
  secondMeeting: boolean;
  scheduledAt: IsoDateTime;
  location?: string;
  onlineUrl?: string;
  agenda: string[];
  secondMeetingPlan?: { scheduledAt: IsoDateTime; location?: string; onlineUrl?: string };
  resend: boolean;
  /**
   * Buyuk sitede bildirim parcalari: worker yalnizca `bucketOf(userId, parts) === part` alicilara
   * gonderir (mesaj basina ~1.000 alici). Yoksa tek parca.
   */
  part?: number;
  parts?: number;
};

/**
 * Genel kurul sonrasi: cagrisi gonderilmis toplanti iptal edildi (`ASSEMBLY_CANCELLED:<id>`; iptal bir
 * kez olur) veya ertelendi / yeri degisti (`ASSEMBLY_RESCHEDULED:<id>:<sira>`). Alicilar toplantinin
 * TUM cagri kayitlarindaki (`ASMCALL#` + kovalar) kullanicilar, hala apartman uyesiyse. Iptal gerekcesi
 * ve erteleme gerekcesi serbest metindir: TASINMAZ, worker toplanti kaydindan okur; toplanti bu arada
 * yeniden degistiyse (eski erteleme) veya kayit olayla uyusmuyorsa bildirim gitmez.
 */
export type AssemblyCancelledPayload = { assemblyId: string; scheduledAt: IsoDateTime; kind: 'ordinary' | 'extraordinary'; part?: number; parts?: number };
export type AssemblyRescheduledPayload = {
  assemblyId: string;
  seq: number;
  kind: 'ordinary' | 'extraordinary';
  previousScheduledAt: IsoDateTime;
  scheduledAt: IsoDateTime;
  location?: string;
  onlineUrl?: string;
  part?: number;
  parts?: number;
};

/**
 * Ihale devami: yonetim ihaleyi sakinlerle paylasti (`TENDER_PUBLISHED`), yayindaki ihaleyi karara
 * bagladi (`TENDER_DECIDED`) veya iptal etti (`TENDER_CANCELLED`; yalnizca yayindan sonra). Payload
 * yalnizca kimlik tasir: worker ihalenin GUNCEL halini okur, durum olayla uyusmuyorsa (ornegin yayin
 * e-postasi sirasinda ihale iptal edilmis) bildirim gitmez. Alici: apartmanin guncel uyeleri.
 * `eventId` = `<tur>:<tenderId>` (her gecis bir kez olur).
 */
export type TenderEventPayload = { tenderId: string };

/**
 * Yayindaki ihaleye yonetim yaniti: onceki yonetim yanitindan bu yanita kadar soru yazmis sakinler
 * (hala apartman uyesiyse) e-posta alir. Yanit metni tasinmaz; worker yorumlari okur.
 * `eventId` = `TENDER_REPLIED:<tenderId>:<commentId>`.
 */
export type TenderRepliedPayload = { tenderId: string; commentId: string };

/**
 * Kapi devami: uyelik yazimi (PATCH / iptal) kullaniciyi bugun itibariyla bolumde oturmayan yapti
 * (bitis tarihi gecmis, iptal, oturan malik artik oturmuyor). Cari kapama bu olayi yazmaz: geri alma
 * payi nedeniyle karar gece taramasinindir. Bildirim DEGILDIR: SNS aboneligiyle zamanlanmis
 * gorev kuyruguna gider (infra/scheduler.tf `scheduler_event_types`) ve worker gece taramasinin
 * kuraliyla (`gate/departures.ts` `departureCandidates`) o kullanicinin o bolumdeki aktif gecis ve
 * araclarini hemen pasife alir. `eventId` = `MEMBERSHIP_ENDED:<userId>:<unitId>:<surum>`.
 */
export type MembershipEndedPayload = {
  userId: string;
  unitId: string;
  source: 'membership';
  endDate?: IsoDate;
};

/**
 * Bildirim devami: arka plan toplu isi (bulkjobs) bitti (`completed` / `completed_with_errors` /
 * `failed`). Alici isi baslatan kullanici (sistem baslattiysa kimse); hala apartmanda aktif yonetim
 * rolu varsa. Sayilar ve baglanti icin is ozeti tasinir, hatali bolum ornekleri tasinmaz.
 * `eventId` = `BULK_JOB_FINISHED:<jobId>:<is surumu>` (yeniden denenen is yeniden bildirir).
 */
export type BulkJobFinishedPayload = {
  jobId: string;
  kind: string;
  status: 'completed' | 'completed_with_errors' | 'failed';
  startedBy: string;
  total: number;
  succeeded: number;
  failed: number;
  written: number;
  periodId?: string;
  label?: string;
  errorMessage?: string;
};

/**
 * Finans 2.2 sonrasi: sakin yapilandirma talebi (`planRequests.ts`). REQUESTED -> yonetim;
 * APPROVED / REJECTED -> talebi acan sakin (hala dairenin uyesiyse). Payload yalnizca kimlik
 * tasir; tutar, taksit ve ret gerekcesi worker'in okudugu guncel talep kaydindan gelir.
 * `eventId` = `<TUR>:<requestId>`.
 */
export type RestructureEventPayload = { requestId: string };

type PayloadByType = {
  DUE_GENERATED: DueGeneratedPayload;
  PAYMENT_RECEIVED: PaymentReceivedPayload;
  ANNOUNCEMENT_PUBLISHED: AnnouncementPublishedPayload;
  LATE_FEE_POSTED: LateFeePostedPayload;
  DUES_REMINDER: DuesReminderPayload;
  DUES_BATCH_SUMMARY: DuesBatchSummaryPayload;
  METER_PERIOD_REVERSED: MeterPeriodReversedPayload;
  TICKET_CREATED: TicketEventPayload;
  TICKET_ASSIGNED: TicketEventPayload;
  TICKET_STATUS_CHANGED: TicketEventPayload;
  TICKET_COMMENTED: TicketEventPayload;
  OPERATIONS_DIGEST: OperationsDigestPayload;
  POLL_PUBLISHED: PollPublishedPayload;
  GATE_COURIER_ARRIVED: GateCourierArrivedPayload;
  GATE_GUEST_ENTERED: GateGuestEnteredPayload;
  RESERVATION_APPROVED: ReservationDecisionPayload;
  RESERVATION_REJECTED: ReservationDecisionPayload;
  RESERVATION_CANCELLED: ReservationDecisionPayload;
  ASSEMBLY_CALLED: AssemblyCalledPayload;
  ASSEMBLY_CANCELLED: AssemblyCancelledPayload;
  ASSEMBLY_RESCHEDULED: AssemblyRescheduledPayload;
  TENDER_PUBLISHED: TenderEventPayload;
  TENDER_DECIDED: TenderEventPayload;
  TENDER_CANCELLED: TenderEventPayload;
  TENDER_REPLIED: TenderRepliedPayload;
  MEMBERSHIP_ENDED: MembershipEndedPayload;
  BULK_JOB_FINISHED: BulkJobFinishedPayload;
  RESTRUCTURE_REQUESTED: RestructureEventPayload;
  RESTRUCTURE_APPROVED: RestructureEventPayload;
  RESTRUCTURE_REJECTED: RestructureEventPayload;
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
