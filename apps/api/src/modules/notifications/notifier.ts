/**
 * Bildirim modeli ve kanal arayuzu (worker ve kanallar arasinda ortak).
 */
import type { NotificationCategory } from './categories.js';

export type NotificationTemplate =
  | 'due_generated'
  | 'dues_batch_summary'
  | 'dues_reversed'
  | 'payment_received'
  | 'announcement_published'
  /** Y1: anket / oylama yayinlandi. */
  | 'poll_published'
  | 'late_fee_posted'
  /** Faz 3 (O1-2): ariza / talep. */
  | 'ticket_created'
  | 'ticket_assigned'
  | 'ticket_status'
  | 'ticket_resolved'
  | 'ticket_reopened'
  | 'ticket_comment'
  /** Faz 3 (O1-3): gunluk operasyon ozeti (yonetim / gorevli). */
  | 'operations_digest'
  /** Guvenlik kapisi: kurye onay istegi (oturan sakinler) ve misafir girisi (gecisi olusturan). */
  | 'gate_courier_arrived'
  | 'gate_guest_entered'
  /** Ortak alan rezervasyonu: yonetimin onayi / reddi / iptali (rezervasyonu yapan sakin). */
  | 'reservation_approved'
  | 'reservation_rejected'
  | 'reservation_cancelled'
  /** Genel kurul: kat malikleri kurulu toplanti cagrisi (oy listesindeki malik kullanicilar). */
  | 'assembly_called'
  /** Genel kurul: cagrisi gonderilmis toplantinin iptali / ertelenmesi (cagri alicilari). */
  | 'assembly_cancelled'
  | 'assembly_rescheduled'
  /** Ihale: sakinlerle paylasim, karar, yayindan sonra iptal (apartman uyeleri) ve soruya yonetim yaniti (soran sakin). */
  | 'tender_published'
  | 'tender_decided'
  | 'tender_cancelled'
  | 'tender_replied'
  /** Bildirim devami: arka plan toplu isinin bitis ozeti (isi baslatan yonetici). */
  | 'bulk_job_summary'
  /** Yapilandirma (taksit) talebi: yeni talep (yonetim), onay / ret (talebi acan sakin). */
  | 'restructure_requested'
  | 'restructure_approved'
  | 'restructure_rejected'
  | `dues_reminder_${'upcoming' | 'overdue_1' | 'overdue_7' | 'plan_default'}`;

/** Ozet bildirimlerdeki kalem satiri (kisisel veri yok). */
export type NotificationLine = { unitId: string; amount: number };

/** Metin satiri (ozet bildirimler; kisisel veri yok). */
export type NotificationItem = { label: string; detail?: string };

export type NotificationData = Record<string, string | number | undefined | NotificationLine[] | NotificationItem[]>;

export type Notification = {
  eventId: string;
  apartmentId: string;
  userId: string;
  template: NotificationTemplate;
  /**
   * Tercih kategorisi (worker olay turunden doldurur; yoksa kanal sablon adindan cozer). Kullanici
   * bu kategoriyi kapattiysa e-posta gitmez.
   */
  category?: NotificationCategory;
  /** Sablon degiskenleri; kisisel veri icermez (ad/e-posta kanal adaptorunde cozulur). */
  data: NotificationData;
};

/** `suppressed`: alici SES geri donus / sikayet nedeniyle engelli (suppressions.ts). */
export type SkipReason = 'already_sent' | 'opted_out' | 'no_email' | 'email_unverified' | 'rejected' | 'no_template' | 'suppressed';

export type DeliveryResult = { status: 'sent' } | { status: 'skipped'; reason: SkipReason };

/** `send` sonuc dondurmezse bildirim gonderilmis sayilir (log kanali). */
export type Notifier = { readonly channel: string; send(n: Notification): Promise<DeliveryResult | void> };

/**
 * Varsayilan kanal: CloudWatch'a yapilandirilmis log (dis gonderim yok). Yalnizca kimlikler ve sablon
 * yazilir; `data` (gerekce, firma, baslik gibi serbest metinler) loga GIRMEZ.
 */
export function createLogNotifier(log: Pick<Console, 'info'> = console): Notifier {
  return {
    channel: 'log',
    async send(n) {
      log.info(JSON.stringify({ msg: 'notification', channel: 'log', eventId: n.eventId, userId: n.userId, template: n.template }));
    },
  };
}
