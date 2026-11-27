/**
 * Faz 3 (O1) ariza / talep ve bakim - saf yardimcilar (API ile ayni sozluk; apps/api/src/modules/tickets).
 * Yetki ve gecis kararlarini API verir (`actions`); burada yalnizca etiket, sure ve gosterim kurallari.
 */

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

export const CATEGORY_LABELS: Record<TicketCategory, string> = {
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

/**
 * Daire ici talepte anlamli kategoriler (sakin sihirbazi). Asansor, havuz, otopark, bahce,
 * hidrofor, jenerator ve temizlik yalnizca ortak alan icindir. `security` daire icinde
 * diyafon / kapi guvenligi demektir.
 */
export const UNIT_CATEGORIES = ['plumbing', 'electrical', 'heating', 'structural', 'security', 'other'] as const satisfies readonly TicketCategory[];

export type TicketLocationKind = 'unit' | 'common';

/** Konuma gore secilebilir kategoriler: daire ici kisitli liste, ortak alan tum liste. */
export function categoriesForLocation(kind: TicketLocationKind): readonly TicketCategory[] {
  return kind === 'unit' ? UNIT_CATEGORIES : TICKET_CATEGORIES;
}

/** Konuma ozel etiket: daire icinde "Guvenlik / diyafon", "Yapi / kapi / pencere". */
export function categoryLabelFor(category: TicketCategory, kind: TicketLocationKind): string {
  if (kind === 'unit' && category === 'security') return 'Güvenlik / diyafon';
  if (kind === 'unit' && category === 'structural') return 'Yapı / kapı / pencere';
  return CATEGORY_LABELS[category];
}

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const PRIORITY_LABELS: Record<TicketPriority, string> = { low: 'Düşük', normal: 'Normal', high: 'Yüksek', urgent: 'Acil' };

export const TICKET_STATUSES = ['open', 'assigned', 'in_progress', 'on_hold', 'resolved', 'closed', 'cancelled'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Açık',
  assigned: 'Atandı',
  in_progress: 'İşlemde',
  on_hold: 'Beklemede',
  resolved: 'Çözüldü',
  closed: 'Kapandı',
  cancelled: 'İptal',
};
/** Pano sutunlari (API `board` ile ayni sira). */
export const BOARD_COLUMNS: readonly TicketStatus[] = ['open', 'assigned', 'in_progress', 'on_hold', 'resolved'];
export const ACTIVE_STATUSES: readonly TicketStatus[] = ['open', 'assigned', 'in_progress', 'on_hold'];

export type Tone = 'neutral' | 'success' | 'warning' | 'accent' | 'danger';
export const STATUS_TONES: Record<TicketStatus, Tone> = {
  open: 'warning',
  assigned: 'accent',
  in_progress: 'accent',
  on_hold: 'neutral',
  resolved: 'success',
  closed: 'neutral',
  cancelled: 'neutral',
};
export const PRIORITY_TONES: Record<TicketPriority, Tone> = { low: 'neutral', normal: 'neutral', high: 'warning', urgent: 'danger' };

export const TRANSITIONS = ['start', 'hold', 'resume', 'resolve', 'confirm', 'close', 'reopen', 'cancel'] as const;
export type TransitionAction = (typeof TRANSITIONS)[number];

export const ACTION_LABELS: Record<TransitionAction, string> = {
  start: 'İşe başla',
  hold: 'Beklet',
  resume: 'Devam et',
  resolve: 'Çözüldü',
  confirm: 'Onayla',
  close: 'Kapat',
  reopen: 'Yeniden aç',
  cancel: 'İptal et',
};

/**
 * Not zorunlu mu (API kurali: model.ts RULES). Iptal yalnizca yoneticide (red) gerekcelidir;
 * acan kisinin geri cekmesi gerekcesizdir.
 */
export function noteRequired(action: TransitionAction, isManager: boolean): boolean {
  if (action === 'cancel') return isManager;
  return action === 'hold' || action === 'resolve' || action === 'close' || action === 'reopen';
}

export const EVENT_LABELS: Record<string, string> = {
  created: 'Talep oluşturuldu',
  status_changed: 'Durum değişti',
  assigned: 'Atama',
  comment: 'Yorum',
  field_changed: 'Bilgiler düzeltildi',
  rated: 'Puanlandı',
  cost_linked: 'Masraf bağlandı',
  cost_unlinked: 'Masraf bağı kaldırıldı',
  cost_charged: 'Daireye yansıtıldı',
  estimate_set: 'Tahmini tutar notu',
};

/** S3 anahtarindan fotograf kimligi (API `photoIdOf` ile ayni: dosya adi, ilk nokta -> `_`). */
export const photoIdOf = (key: string) => key.slice(key.lastIndexOf('/') + 1).replace('.', '_');

/**
 * SLA metni: "3 sa 20 dk kaldı" / "2 gün gecikti". Cozum bekleyen durumlar disinda bos.
 */
export function slaText(t: { status: TicketStatus; dueAt: string }, now: Date = new Date()): { text: string; overdue: boolean } | null {
  if (!ACTIVE_STATUSES.includes(t.status)) return null;
  const diff = Date.parse(t.dueAt) - now.getTime();
  const overdue = diff < 0;
  const mins = Math.floor(Math.abs(diff) / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rest = mins % 60;
  const span = days > 0 ? `${days} gün${hours ? ` ${hours} sa` : ''}` : hours > 0 ? `${hours} sa${rest ? ` ${rest} dk` : ''}` : `${Math.max(rest, 1)} dk`;
  return { text: overdue ? `${span} gecikti` : `${span} kaldı`, overdue };
}

export type LocationLike = { kind: 'unit'; unitId: string; blockId?: string } | { kind: 'common'; area: string; blockId?: string };

/** Konum metni: "Daire 5" / "Ortak alan · Lobi". */
export function locationText(l: LocationLike, unitLabel?: (unitId: string) => string | undefined): string {
  if (l.kind === 'unit') return `Daire ${unitLabel?.(l.unitId) ?? l.unitId}`;
  return `Ortak alan · ${l.area}`;
}

/** Kucuk harf duyarsiz Turkce arama (numara ve baslik). */
export function matchesTicket(t: { number: string; title: string }, q: string): boolean {
  const term = q.trim().toLocaleLowerCase('tr');
  if (!term) return true;
  return t.number.toLocaleLowerCase('tr').includes(term) || t.title.toLocaleLowerCase('tr').includes(term);
}

export const RATING_LABELS = ['', 'Çok kötü', 'Kötü', 'Orta', 'İyi', 'Çok iyi'] as const;
