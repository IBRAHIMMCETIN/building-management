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

export type SkipReason = 'already_sent' | 'opted_out' | 'no_email' | 'email_unverified' | 'rejected' | 'no_template';

export type DeliveryResult = { status: 'sent' } | { status: 'skipped'; reason: SkipReason };

/** `send` sonuc dondurmezse bildirim gonderilmis sayilir (log kanali). */
export type Notifier = { readonly channel: string; send(n: Notification): Promise<DeliveryResult | void> };

/** Varsayilan kanal: CloudWatch'a yapilandirilmis log (dis gonderim yok). */
export function createLogNotifier(log: Pick<Console, 'info'> = console): Notifier {
  return {
    channel: 'log',
    async send(n) {
      log.info(JSON.stringify({ msg: 'notification', channel: 'log', ...n }));
    },
  };
}
