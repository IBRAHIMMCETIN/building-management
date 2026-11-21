/**
 * Bildirim modeli ve kanal arayuzu (worker ve kanallar arasinda ortak).
 */

export type NotificationTemplate =
  | 'due_generated'
  | 'dues_batch_summary'
  | 'payment_received'
  | 'announcement_published'
  | 'late_fee_posted'
  | `dues_reminder_${'upcoming' | 'overdue_1' | 'overdue_7'}`;

/** Ozet bildirimlerdeki kalem satiri (kisisel veri yok). */
export type NotificationLine = { unitId: string; amount: number };

export type NotificationData = Record<string, string | number | undefined | NotificationLine[]>;

export type Notification = {
  eventId: string;
  apartmentId: string;
  userId: string;
  template: NotificationTemplate;
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
