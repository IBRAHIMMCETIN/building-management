import { type NotificationCategory, categoryOfTemplate } from './categories.js';
import type { Notification, NotificationLine } from './notifier.js';
import { formatDate, formatDateTime, formatPeriod, formatTL, ticketStatusText } from './templates.js';

/**
 * Mobil bildirim (push) metinleri: kisa Turkce baslik + govde ve uygulama ici baglanti (`path`; mesajda `data.url`).
 *
 * Kilit ekraninda gorunebilir: e-postada olmayan hicbir kisisel veri eklenmez; serbest metin gerekceler
 * (ret / iptal gerekcesi, ihale yaniti, talep mesaji), firma, adres ve cevrim ici baglanti push'a
 * girmez. Guvenlik kapisi bildirimleri en az bilgiyle (bolum, firma, saat yok) gider; ayrinti uygulamada.
 *
 * Uygulama ici baglantilar (mobil uygulama bu yollari karsilar; mesajda `data.url`):
 *   /borclar                    aidat / tahsilat (tahakkuk, makbuz, tazminat, hatirlatma)
 *   /duyurular/<announcementId> duyuru
 *   /oylamalar/<pollId>         anket / oylama
 *   /talepler/<ticketId>        ariza / talep (yonetim ve gorevli dahil); /talepler gunluk ozet
 *   /kapi                       ziyaretci / kurye
 *   /rezervasyonlar             ortak alan rezervasyonu
 *   /genel-kurul/<assemblyId>   kat malikleri kurulu cagrisi
 *   /ihaleler/<tenderId>        ihale
 *   /abonelik                   abonelik (yalnizca yonetim rolleri; mobilde yonetim paneli ekrani)
 *
 * Android bildirim kanallari (uygulama acilista olusturmali; olmayan kanaldaki bildirim gosterilmez):
 *   `default` (Genel bildirimler) ve `gate` (Kapı ve kurye, yuksek onem).
 */

export const ANDROID_CHANNELS = {
  default: { name: 'Genel bildirimler', importance: 'default' },
  gate: { name: 'Kapı ve kurye', importance: 'high' },
} as const;
export type AndroidChannelId = keyof typeof ANDROID_CHANNELS;

export type PushContent = {
  title: string;
  body: string;
  /** Uygulama ici yol. */
  path: string;
  channelId: AndroidChannelId;
  priority: 'default' | 'high';
  /** Gecerlilik (sn): suresi gecen bildirim cihaza teslim edilmez (kurye onayi). */
  ttlSeconds?: number;
  category?: NotificationCategory;
};

const TITLE_MAX = 80;
const BODY_MAX = 180;

/** Tek satir, kontrol karakteri yok, sinirli uzunluk. */
export function cleanPushText(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : String(v));
const lines = (v: unknown): NotificationLine[] => (Array.isArray(v) ? (v as NotificationLine[]) : []);
const id = (v: unknown) => encodeURIComponent(str(v));
const withId = (base: string, v: unknown) => (str(v) ? `${base}/${id(v)}` : base);
const total = (v: unknown) => lines(v).reduce((s, i) => s + num(i.amount), 0);

type Spec = Omit<PushContent, 'channelId' | 'priority' | 'category'> & Partial<Pick<PushContent, 'channelId' | 'priority'>>;

function spec(n: Notification, now: Date): Spec | undefined {
  const d = n.data;
  switch (n.template) {
    case 'payment_received':
      return { title: 'Ödemeniz alındı', body: `${formatTL(num(d.amount))} tutarındaki ödemeniz kaydedildi. Makbuz no: ${str(d.receiptNumber)}`, path: '/borclar' };
    case 'due_generated':
      return { title: 'Yeni borç kaydı', body: `${str(d.description)}: ${formatTL(num(d.amount))}, son ödeme ${formatDate(d.dueDate)}`, path: '/borclar' };
    case 'dues_batch_summary':
      return { title: `${str(d.description) || 'Aidat'} tahakkuk edildi`, body: `Toplam ${formatTL(total(d.items))}, son ödeme ${formatDate(d.dueDate)}`, path: '/borclar' };
    case 'dues_reversed':
      return { title: 'Tahakkuk geri alındı', body: `"${str(d.description)}" tahakkuku düzeltme için geri alındı (${formatTL(total(d.items))}).`, path: '/borclar' };
    case 'late_fee_posted':
      return { title: 'Gecikme tazminatı', body: `${formatPeriod(d.period)} dönemi için ${formatTL(num(d.amount))} hesabınıza yansıtıldı.`, path: '/borclar' };
    case 'dues_reminder_upcoming':
      return { title: 'Son ödeme tarihi yaklaşıyor', body: `${formatTL(num(d.amount))} tutarındaki borcunuzun son ödeme tarihi ${formatDate(d.dueDate)}.`, path: '/borclar' };
    case 'dues_reminder_overdue_1':
    case 'dues_reminder_overdue_7':
      return {
        title: n.template === 'dues_reminder_overdue_7' ? 'Ödemesi 7 gündür geciken borcunuz var' : 'Ödemesi geciken borcunuz var',
        body: `${formatTL(num(d.amount))}, son ödeme tarihi ${formatDate(d.dueDate)} idi.`,
        path: '/borclar',
      };
    case 'dues_reminder_plan_default':
      return { title: 'Taksit planınızda gecikme', body: 'Geciken taksitleri ödeyerek planınızı sürdürebilirsiniz.', path: '/borclar' };
    case 'announcement_published':
      return { title: 'Yeni duyuru', body: str(d.title), path: withId('/duyurular', d.announcementId) };
    case 'poll_published':
      return { title: 'Yeni oylama', body: `${str(d.title)} · bitiş ${formatDateTime(d.closesAt)}`, path: withId('/oylamalar', d.pollId) };
    case 'ticket_created':
      return { title: d.priority === 'urgent' ? 'ACİL - Yeni arıza / talep' : 'Yeni arıza / talep', body: `${str(d.number)} ${str(d.title)}`, path: withId('/talepler', d.ticketId), ...(d.priority === 'urgent' ? { priority: 'high' as const } : {}) };
    case 'ticket_assigned':
      return { title: 'Size iş atandı', body: `${str(d.number)} ${str(d.title)}`, path: withId('/talepler', d.ticketId) };
    case 'ticket_status':
      return { title: 'Talep durumu güncellendi', body: `${str(d.number)}: ${ticketStatusText(d)}`, path: withId('/talepler', d.ticketId) };
    case 'ticket_resolved':
      return { title: 'Talebiniz çözüldü', body: `${str(d.number)} ${str(d.title)} - onaylayın veya yeniden açın.`, path: withId('/talepler', d.ticketId) };
    case 'ticket_reopened':
      return { title: 'Talep yeniden açıldı', body: `${str(d.number)} ${str(d.title)}`, path: withId('/talepler', d.ticketId) };
    case 'ticket_comment':
      return { title: 'Talebe yeni mesaj', body: `${str(d.number)} ${str(d.title)}`, path: withId('/talepler', d.ticketId) };
    case 'operations_digest': {
      const parts = [
        num(d.slaCount) ? `${num(d.slaCount)} SLA aşımı` : '',
        num(d.overdueCount) ? `${num(d.overdueCount)} geciken bakım` : '',
        num(d.dueCount) ? `${num(d.dueCount)} yaklaşan bakım` : '',
        num(d.autoClosed) ? `${num(d.autoClosed)} otomatik kapanan talep` : '',
        num(d.equipmentCount) ? `${num(d.equipmentCount)} ekipman tarihi` : '',
      ].filter(Boolean);
      return { title: `Günlük özet ${formatDate(d.date)}`, body: parts.join(', ') || 'Bekleyen iş yok', path: '/talepler' };
    }
    // Guvenlik kapisi: en az bilgi (firma, bolum, saat yok).
    case 'gate_courier_arrived': {
      const left = Math.floor((Date.parse(str(d.respondBy)) - now.getTime()) / 1000);
      return {
        title: 'Kapıda kuryeniz var',
        body: 'Kuryeyi içeri almak için onaylayın veya reddedin.',
        path: '/kapi',
        channelId: 'gate',
        priority: 'high',
        ...(Number.isFinite(left) ? { ttlSeconds: Math.max(60, left) } : {}),
      };
    }
    case 'gate_guest_entered':
      return { title: 'Misafiriniz giriş yaptı', body: 'Misafir geçişinizle güvenlikten giriş kaydedildi.', path: '/kapi', channelId: 'gate' };
    case 'reservation_approved':
    case 'reservation_rejected':
    case 'reservation_cancelled': {
      const title = n.template === 'reservation_approved' ? 'Rezervasyonunuz onaylandı' : n.template === 'reservation_rejected' ? 'Rezervasyon talebiniz reddedildi' : 'Rezervasyonunuz iptal edildi';
      return { title, body: `${str(d.facilityName) || 'Ortak alan'}, ${formatDate(d.date)} ${formatDateTime(d.start, true)}-${formatDateTime(d.end, true)}`, path: '/rezervasyonlar' };
    }
    case 'assembly_called':
      return {
        title: `${d.resend === 'true' ? 'Güncellenen çağrı: ' : ''}Kat malikleri kurulu toplantısı`,
        body: `${formatDateTime(d.scheduledAt)} (Türkiye saati). Gündem ve ayrıntılar için dokunun.`,
        path: withId('/genel-kurul', d.assemblyId),
      };
    case 'tender_published':
      return { title: 'İhale teklifleri paylaşıldı', body: str(d.title), path: withId('/ihaleler', d.tenderId) };
    case 'tender_decided':
      return { title: 'İhale sonuçlandı', body: str(d.title), path: withId('/ihaleler', d.tenderId) };
    case 'tender_cancelled':
      return { title: 'İhale iptal edildi', body: str(d.title), path: withId('/ihaleler', d.tenderId) };
    case 'tender_replied':
      return { title: 'Sorunuz yanıtlandı', body: str(d.title), path: withId('/ihaleler', d.tenderId) };
    // Abonelik (yonetim rolleri): mobilde yonetim paneli ekranina duser (bilinmeyen kok yol).
    case 'billing_trial_ending':
      return { title: 'Deneme süreniz bitiyor', body: `Deneme ${formatDate(d.trialEndsAt)} tarihinde bitiyor.`, path: '/abonelik' };
    case 'billing_invoice_issued':
      return { title: 'Abonelik faturası kesildi', body: `${formatTL(num(d.totalKurus))}, son ödeme ${formatDate(d.dueDate)}`, path: '/abonelik' };
    case 'billing_past_due':
      return { title: 'Abonelik ödemeniz gecikti', body: `Ödeme alınmazsa ${formatDate(d.suspendOn)} tarihinde salt okunur moda geçilir.`, path: '/abonelik' };
    case 'billing_suspended':
      return { title: 'Aboneliğiniz askıya alındı', body: 'Hesabınız salt okunur modda.', path: '/abonelik' };
    case 'billing_reactivated':
      return { title: 'Aboneliğiniz yeniden açıldı', body: 'Salt okunur mod kaldırıldı.', path: '/abonelik' };
    default:
      return undefined;
  }
}

/** Bildirimi push icerigine donusturur; sablonu olmayan bildirimde `undefined`. */
export function renderPush(n: Notification, now: Date = new Date()): PushContent | undefined {
  const s = spec(n, now);
  if (!s) return undefined;
  const category = n.category ?? categoryOfTemplate(n.template);
  return {
    title: cleanPushText(s.title, TITLE_MAX),
    body: cleanPushText(s.body, BODY_MAX),
    path: s.path,
    channelId: s.channelId ?? 'default',
    priority: s.priority ?? 'default',
    ...(s.ttlSeconds !== undefined ? { ttlSeconds: s.ttlSeconds } : {}),
    ...(category ? { category } : {}),
  };
}
