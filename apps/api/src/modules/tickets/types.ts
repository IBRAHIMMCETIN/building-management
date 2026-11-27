/**
 * Faz 3 (O1) - Ariza / talep kayitlari. Tek tablo, `PK = APT#<apartmentId>`:
 *
 *   TICKET#<ticketId>                         talep (surumlu)
 *   TKEV#<ticketId>#<ts>#<eventId>            zaman cizelgesi (append-only)
 *   TKUNIT#<unitId>#<ticketId>                daire indeksi (sakin portali; yalnizca eklenir, konum
 *                                             degisince eskisi kalir, okuma guncel konuma gore suzer)
 *   TKUSER#<userId>#<ticketId>                acan kisi indeksi (sakin portali)
 *   TKIDEM#<idempotencyKey>                   olusturma idempotency kaydi
 *   CTR#ticket                                okunur numara sayaci (T-000123)
 *
 * Hicbir kayit silinmez (API ve zamanlayici Lambda'larinin DeleteItem yetkisi yok); iptal ve kapanis
 * birer durumdur.
 */
import type { CostSummary, StaffEstimate } from '../workcosts/types.js';
import type { AuditFields, IsoDateTime, TableKeys } from '../core/types.js';

export const TICKET_CATEGORIES = [
  'elevator',
  'plumbing',
  'electrical',
  'heating',
  'water_pump',
  'generator',
  'cleaning',
  'garden',
  'pool',
  'security',
  'structural',
  'parking',
  'other',
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_CATEGORY_LABELS: Record<TicketCategory, string> = {
  elevator: 'Asansör',
  plumbing: 'Su / tesisat',
  electrical: 'Elektrik',
  heating: 'Isınma',
  water_pump: 'Hidrofor',
  generator: 'Jeneratör',
  cleaning: 'Temizlik',
  garden: 'Bahçe',
  pool: 'Havuz',
  security: 'Güvenlik',
  structural: 'Yapı / çatı / cephe',
  parking: 'Otopark',
  other: 'Diğer',
};

/** Yapisal / demirbas niteligindeki kategoriler: daire ici taleplerde kat malikine de bildirilir. */
export const OWNER_CATEGORIES: readonly TicketCategory[] = ['structural', 'plumbing', 'heating'];

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = ['open', 'assigned', 'in_progress', 'on_hold', 'resolved', 'closed', 'cancelled'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
/** Islem biten durumlar (SLA ve gecikme hesabina girmez). */
export const TERMINAL_STATUSES: readonly TicketStatus[] = ['closed', 'cancelled'];
/** Cozum bekleyen (SLA isleyen) durumlar. */
export const ACTIVE_STATUSES: readonly TicketStatus[] = ['open', 'assigned', 'in_progress', 'on_hold'];

export const TICKET_SOURCES = ['resident', 'staff', 'manager', 'security', 'maintenance'] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

export type TicketLocation =
  | { kind: 'unit'; unitId: string; blockId?: string }
  | { kind: 'common'; blockId?: string; area: string };

export type TicketRating = { score: number; note?: string; at: IsoDateTime; by: string };

export type Ticket = TableKeys &
  AuditFields & {
    entityType: 'TICKET';
    apartmentId: string;
    ticketId: string;
    /** Okunur numara: `T-000123`. */
    number: string;
    title: string;
    description: string;
    category: TicketCategory;
    priority: TicketPriority;
    location: TicketLocation;
    status: TicketStatus;
    source: TicketSource;
    /** Acanin o anki rolu (gosterim ve yetki ozeti). */
    createdByRole: string;
    assigneeId?: string;
    assignedAt?: IsoDateTime;
    /** Bakim gorevinden acildiysa (O1-3). */
    maintenanceTaskId?: string;
    /** SLA hedefi: olusturma + oncelik suresi. Oncelik degisince yeniden hesaplanir. */
    dueAt: IsoDateTime;
    resolvedAt?: IsoDateTime;
    /** Cozum aninda SLA tutturuldu mu. */
    slaMet?: boolean;
    closedAt?: IsoDateTime;
    /** `confirmed` sakin onayi, `forced` yonetici, `auto` sure dolumu (O1-3 isi). */
    closeKind?: 'confirmed' | 'forced' | 'auto';
    cancelledAt?: IsoDateTime;
    /** `withdrawn` acan kisi geri cekti, `rejected` yonetici reddetti. */
    cancelKind?: 'withdrawn' | 'rejected';
    rating?: TicketRating;
    reopenCount: number;
    photoCount: number;
    /** O1-4: bagli masraflar ve daireye yansitmalar (Finans). */
    costSummary?: CostSummary;
    /** v2: ekipman sicili baglantisi (ayni apartman; istege bagli). */
    equipmentId?: string;
    /** v2: gorevlinin tahmini tutar notu (bilgi amacli, deftere yazilmaz; sakine donmez). */
    estimate?: StaffEstimate;
  };

export const TICKET_EVENT_KINDS = [
  'created',
  'status_changed',
  'assigned',
  'comment',
  'field_changed',
  'rated',
  'cost_linked',
  'cost_unlinked',
  /** O1-4: masrafin daireye yansitilmasi (yonetici onayli tahakkuk). */
  'cost_charged',
  /** v2: tahmini tutar notu girildi / degisti / kaldirildi (ic olay). */
  'estimate_set',
] as const;
export type TicketEventKind = (typeof TICKET_EVENT_KINDS)[number];

export type TicketEvent = TableKeys & {
  entityType: 'TICKET_EVENT';
  apartmentId: string;
  ticketId: string;
  eventId: string;
  kind: TicketEventKind;
  /** `internal` olaylar sakin uclarina hic donmez. */
  visibility: 'public' | 'internal';
  at: IsoDateTime;
  by: string;
  byRole: string;
  from?: TicketStatus;
  to?: TicketStatus;
  /** Atama: yeni gorevli (bos = atama kaldirildi). */
  assigneeId?: string;
  body?: string;
  /** Degisen alanlar (field_changed): { alan: [eski, yeni] }. */
  changes?: Record<string, [unknown, unknown]>;
  photoKeys?: string[];
  rating?: number;
  /** O1-4 masraf olaylari (kurus). */
  amount?: number;
  expenseId?: string;
  transactionId?: string;
};

export type TicketIndex = TableKeys & { entityType: 'TICKET_INDEX'; apartmentId: string; ticketId: string; createdAt: IsoDateTime };

export type TicketSettings = {
  /** Oncelik -> SLA hedefi (saat). */
  slaHours: Record<TicketPriority, number>;
  /** Gorevli atanmamis talepleri gorup kendine ustlenebilir. */
  staffSelfAssign: boolean;
  /** Cozulen talep sakin onaylamazsa bu kadar gun sonra kapanir; sakin bu sure icinde yeniden acabilir. */
  autoCloseDays: number;
};

/** Karar 2, 3, 6 (25.11.2026). */
export const DEFAULT_TICKET_SETTINGS: TicketSettings = {
  slaHours: { urgent: 4, high: 24, normal: 72, low: 168 },
  staffSelfAssign: true,
  autoCloseDays: 7,
};

export const ticketKeys = {
  ticket: (apartmentId: string, ticketId: string): TableKeys => ({ PK: `APT#${apartmentId}`, SK: `TICKET#${ticketId}` }),
  event: (apartmentId: string, ticketId: string, at: IsoDateTime, eventId: string): TableKeys => ({
    PK: `APT#${apartmentId}`,
    SK: `TKEV#${ticketId}#${at}#${eventId}`,
  }),
  eventPrefix: (ticketId: string) => `TKEV#${ticketId}#`,
  unit: (apartmentId: string, unitId: string, ticketId: string): TableKeys => ({ PK: `APT#${apartmentId}`, SK: `TKUNIT#${unitId}#${ticketId}` }),
  unitPrefix: (unitId: string) => `TKUNIT#${unitId}#`,
  user: (apartmentId: string, userId: string, ticketId: string): TableKeys => ({ PK: `APT#${apartmentId}`, SK: `TKUSER#${userId}#${ticketId}` }),
  userPrefix: (userId: string) => `TKUSER#${userId}#`,
  idempotency: (apartmentId: string, key: string): TableKeys => ({ PK: `APT#${apartmentId}`, SK: `TKIDEM#${key}` }),
  counter: (apartmentId: string): TableKeys => ({ PK: `APT#${apartmentId}`, SK: 'CTR#ticket' }),
};
export const TICKET_PREFIX = 'TICKET#';
