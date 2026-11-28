import type { Notification, NotificationItem, NotificationLine } from './notifier.js';
import { TICKET_CATEGORY_LABELS } from '../tickets/types.js';
import { COURIER_APPROVAL_VALID_MINUTES } from '../gate/types.js';

/**
 * Turkce e-posta sablonlari (HTML + duz metin).
 *
 * Sablonlar yalnizca YAPI dondurur (baslik, paragraflar, satirlar, tablo, buton); HTML'i tek
 * bir yer (`renderEmail`) uretir ve kullanici/site/aciklama kaynakli TUM metinleri orada
 * escape eder. Boylece yeni bir sablon yanlislikla ham HTML basamaz (XSS onlemi). Baglanti
 * adresleri yalnizca `https://` (yerelde `http://localhost`) ise kullanilir.
 *
 * Tasarim: tek sutun, en fazla 560 px, tablo tabanli yerlesim ve satir ici stiller (e-posta
 * istemcileri <style> ve modern CSS'i guvenilir desteklemez); mobilde tam genislik.
 */

export type EmailContext = {
  siteName: string;
  recipientName?: string;
  /** Daire etiketi: "A Blok - 5" (bilinmiyorsa "Bagimsiz bolum"). */
  unitLabel: (unitId: string) => string;
  /** Sakin portali kok adresi (ornegin https://site.example/app). */
  portalUrl?: string;
};

export type RenderedEmail = { subject: string; html: string; text: string; preheader: string };

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'rows'; rows: [label: string, value: string][] }
  | { kind: 'table'; head: [string, string]; rows: [string, string][]; total?: [string, string] }
  /** Numarali liste (genel kurul gundemi). */
  | { kind: 'list'; title: string; items: string[] }
  | { kind: 'note'; text: string };

type Spec = { subject: string; heading: string; preheader: string; blocks: Block[]; cta?: { label: string; path: string } };

// ---------------------------------------------------------------------------
// Bicimlendirme
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] as string);
}

/** Konu satiri: satir sonu/kontrol karakteri yok, makul uzunluk. */
export function cleanSubject(value: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 150 ? `${flat.slice(0, 147)}...` : flat;
}

/** Kurus (tam sayi) -> "1.500,50 TL". Kayan nokta kullanilmaz. */
export function formatTL(kurus: number): string {
  if (!Number.isSafeInteger(kurus)) throw new Error(`Gecersiz tutar: ${kurus}`);
  const sign = kurus < 0 ? '-' : '';
  const abs = Math.abs(kurus);
  const lira = Math.trunc(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${lira},${String(abs % 100).padStart(2, '0')} TL`;
}

/** YYYY-MM-DD -> GG.AA.YYYY (gecersizse oldugu gibi). */
export function formatDate(iso: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso ?? '');
}

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

const ISTANBUL_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Istanbul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** ISO an -> Istanbul saatiyle "GG.AA.YYYY SS:DD" (`timeOnly`: "SS:DD"); gecersizse oldugu gibi. */
export function formatDateTime(iso: unknown, timeOnly = false): string {
  const ms = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(ms)) return String(iso ?? '');
  const p = Object.fromEntries(ISTANBUL_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const time = `${p.hour}:${p.minute}`;
  return timeOnly ? time : `${p.day}.${p.month}.${p.year} ${time}`;
}

/** Dakika -> "2 saat" / "90 dakika" / "1 saat 30 dakika". */
export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} dakika`;
  return m ? `${h} saat ${m} dakika` : `${h} saat`;
}

/** YYYY-MM -> "Ekim 2026". */
export function formatPeriod(period: unknown): string {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period ?? ''));
  const name = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && name ? `${name} ${m[1]}` : String(period ?? '');
}

const num = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : String(v));
const lines = (v: unknown): NotificationLine[] => (Array.isArray(v) ? (v as NotificationLine[]) : []);

/** Yalnizca guvenli baglanti: https, yerelde http://localhost / 127.0.0.1. */
export function safeUrl(base: string | undefined, path: string): string | undefined {
  if (!base) return undefined;
  let url: URL;
  try {
    url = new URL(path.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`);
  } catch {
    return undefined;
  }
  const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  return url.protocol === 'https:' || local ? url.toString() : undefined;
}

// ---------------------------------------------------------------------------
// Sablonlar
// ---------------------------------------------------------------------------

function spec(n: Notification, ctx: EmailContext): Spec | undefined {
  const d = n.data;
  const unit = ctx.unitLabel(str(d.unitId));
  switch (n.template) {
    case 'payment_received':
      return {
        subject: `Ödemeniz alındı - ${unit}`,
        heading: 'Ödemeniz alındı',
        preheader: `${formatTL(num(d.amount))} tutarındaki ödemeniz kaydedildi.`,
        blocks: [
          { kind: 'p', text: `${unit} için yaptığınız ödeme hesabınıza işlenmiştir. Teşekkür ederiz.` },
          { kind: 'rows', rows: [['Tutar', formatTL(num(d.amount))], ['Ödeme tarihi', formatDate(d.paidAt)], ['Makbuz no', str(d.receiptNumber)], ['Bağımsız bölüm', unit]] },
          { kind: 'note', text: 'Makbuzunuzu sakin portalındaki Borçlarım ekranından indirebilirsiniz.' },
        ],
        cta: { label: 'Makbuzu görüntüle', path: 'dues' },
      };
    case 'due_generated':
      return {
        subject: `Yeni borç kaydı: ${str(d.description)}`,
        heading: 'Yeni borç kaydı',
        preheader: `${formatTL(num(d.amount))}, son ödeme ${formatDate(d.dueDate)}.`,
        blocks: [
          { kind: 'p', text: `${unit} adına aşağıdaki borç kaydedilmiştir.` },
          { kind: 'rows', rows: [['Açıklama', str(d.description)], ['Tutar', formatTL(num(d.amount))], ['Son ödeme tarihi', formatDate(d.dueDate)], ['Bağımsız bölüm', unit]] },
          { kind: 'note', text: 'Son ödeme tarihinden sonra ödenmeyen tutara, yönetim planında belirlenen oranda gecikme tazminatı uygulanabilir.' },
        ],
        cta: { label: 'Borçlarımı görüntüle', path: 'dues' },
      };
    case 'dues_batch_summary': {
      const items = lines(d.items);
      const total = items.reduce((s, i) => s + num(i.amount), 0);
      const single = items.length === 1;
      return {
        subject: `${str(d.description)} tahakkuk edildi`,
        heading: str(d.description) || 'Toplu tahakkuk',
        preheader: `Toplam ${formatTL(total)}, son ödeme ${formatDate(d.dueDate)}.`,
        blocks: [
          { kind: 'p', text: single ? 'Bağımsız bölümünüz için aşağıdaki tahakkuk yapılmıştır.' : `${items.length} bağımsız bölümünüz için aşağıdaki tahakkuklar yapılmıştır.` },
          {
            kind: 'table',
            head: ['Bağımsız bölüm', 'Tutar'],
            rows: items.map((i) => [ctx.unitLabel(i.unitId), formatTL(num(i.amount))]),
            ...(single ? {} : { total: ['Toplam', formatTL(total)] as [string, string] }),
          },
          { kind: 'rows', rows: [['Son ödeme tarihi', formatDate(d.dueDate)]] },
        ],
        cta: { label: 'Borçlarımı görüntüle', path: 'dues' },
      };
    }
    case 'dues_reversed': {
      const items = lines(d.items);
      const total = items.reduce((s, i) => s + num(i.amount), 0);
      return {
        subject: `${str(d.description)} tahakkuku geri alındı`,
        heading: 'Tahakkuk geri alındı',
        preheader: `Toplam ${formatTL(total)} tutarındaki kayıt düzeltme için geri alındı.`,
        blocks: [
          { kind: 'p', text: `"${str(d.description)}" tahakkuku hatalı okuma düzeltmesi nedeniyle geri alınmıştır. Düzeltilmiş tahakkuk yapıldığında ayrıca bildirilecektir.` },
          { kind: 'table', head: ['Bağımsız bölüm', 'Geri alınan tutar'], rows: items.map((i) => [ctx.unitLabel(i.unitId), formatTL(num(i.amount))]) },
          { kind: 'note', text: 'Bu tutar için yaptığınız ödemeler hesabınızda avans olarak kalır ve sonraki borçlarınıza mahsup edilir.' },
        ],
        cta: { label: 'Hesabımı görüntüle', path: 'dues' },
      };
    }
    case 'late_fee_posted':
      return {
        subject: `Gecikme tazminatı: ${formatPeriod(d.period)}`,
        heading: 'Gecikme tazminatı yansıtıldı',
        preheader: `${formatPeriod(d.period)} dönemi için ${formatTL(num(d.amount))}.`,
        blocks: [
          { kind: 'p', text: `${unit} için vadesi geçmiş borçlara ${formatPeriod(d.period)} döneminde işleyen gecikme tazminatı hesabınıza yansıtılmıştır.` },
          { kind: 'rows', rows: [['Dönem', formatPeriod(d.period)], ['Tutar', formatTL(num(d.amount))], ['Bağımsız bölüm', unit]] },
          { kind: 'note', text: 'Tazminat günlük (kıstelyevm) hesaplanır; yaptığınız ödemeler, ödenen kısım için tazminatı ödeme gününden itibaren durdurur.' },
        ],
        cta: { label: 'Borçlarımı görüntüle', path: 'dues' },
      };
    case 'dues_reminder_upcoming':
    case 'dues_reminder_overdue_1':
    case 'dues_reminder_overdue_7': {
      const upcoming = n.template === 'dues_reminder_upcoming';
      const heading = upcoming ? 'Son ödeme tarihi yaklaşıyor' : n.template === 'dues_reminder_overdue_7' ? 'Ödemesi 7 gündür geciken borcunuz var' : 'Ödemesi geciken borcunuz var';
      return {
        subject: upcoming ? `Hatırlatma: son ödeme tarihi ${formatDate(d.dueDate)}` : heading,
        heading,
        preheader: `${unit}: ${formatTL(num(d.amount))}`,
        blocks: [
          { kind: 'p', text: upcoming ? `${unit} için ödenmemiş borcunuzun son ödeme tarihi yaklaşıyor.` : `${unit} için son ödeme tarihi geçmiş borcunuz bulunmaktadır.` },
          { kind: 'rows', rows: [['Tutar', formatTL(num(d.amount))], ['Son ödeme tarihi', formatDate(d.dueDate)]] },
          ...(upcoming ? [] : [{ kind: 'note' as const, text: 'Gecikme tazminatı vade tarihinden itibaren günlük olarak işlemektedir.' }]),
        ],
        cta: { label: upcoming ? 'Borçlarımı görüntüle' : 'Şimdi öde', path: upcoming ? 'dues' : 'odeme' },
      };
    }
    case 'dues_reminder_plan_default':
      return {
        subject: 'Taksit planınızda gecikme',
        heading: 'Taksit planınızda geciken ödemeler var',
        preheader: `${unit}: ${formatTL(num(d.amount))}`,
        blocks: [
          { kind: 'p', text: `${unit} için yapılandırılan borcunuzun taksitlerinde gecikme tespit edildi. Planın koşullarına göre kalan borcun tamamı muaccel hale gelebilir.` },
          { kind: 'rows', rows: [['Kalan plan borcu', formatTL(num(d.amount))], ['Geciken ilk taksit vadesi', formatDate(d.dueDate)]] },
          { kind: 'note', text: 'Geciken taksitleri ödeyerek planınızı sürdürebilirsiniz.' },
        ],
        cta: { label: 'Şimdi öde', path: 'odeme' },
      };
    case 'announcement_published':
      return {
        subject: `Yeni duyuru: ${str(d.title)}`,
        heading: 'Yeni duyuru',
        preheader: str(d.title),
        blocks: [
          { kind: 'p', text: `Yönetim yeni bir duyuru yayınladı: ${str(d.title)}` },
          { kind: 'note', text: 'Duyurunun tamamını sakin portalındaki Duyurular ekranında okuyabilirsiniz.' },
        ],
        cta: { label: 'Duyuruyu oku', path: 'announcements' },
      };
    case 'poll_published':
      return {
        subject: `Yeni oylama: ${str(d.title)}`,
        heading: 'Yeni oylama',
        preheader: str(d.title),
        blocks: [
          { kind: 'p', text: `Yönetim yeni bir oylama başlattı: ${str(d.title)}` },
          { kind: 'rows', rows: [['Başlangıç', formatDateTime(d.opensAt)], ['Bitiş', formatDateTime(d.closesAt)]] },
          {
            kind: 'note',
            text:
              d.audience === 'owners'
                ? 'Bu oylamada kat malikleri oy kullanır. Her bağımsız bölüm için tek oy sayılır; paydaşlardan birinin sonraki oyu öncekinin yerine geçer.'
                : 'Her bağımsız bölüm için tek oy sayılır; dairenizden verilen sonraki oy öncekinin yerine geçer.',
          },
        ],
        cta: { label: 'Oylamaya git', path: 'oylamalar' },
      };
    // Faz 3 (O1-2): ariza / talep. `link`: portal (sakin) veya admin (yonetim / gorevli).
    case 'ticket_created':
    case 'ticket_assigned':
    case 'ticket_status':
    case 'ticket_resolved':
    case 'ticket_reopened':
    case 'ticket_comment':
      return ticketSpec(n, ctx);
    case 'operations_digest':
      return digestSpec(n);
    case 'bulk_job_summary':
      return bulkJobSpec(n);
    // Guvenlik kapisi (portal 15 sn'de bir yenilemeye devam eder; e-posta ek kanaldir).
    case 'gate_courier_arrived': {
      const company = str(d.company);
      return {
        subject: `Kapıda kurye var - ${unit}`,
        heading: 'Kapıda kuryeniz var',
        preheader: `Yanıt için son saat ${formatDateTime(d.respondBy, true)}.`,
        blocks: [
          { kind: 'p', text: `Güvenlik, ${unit} için ${company ? `${company} kuryesi` : 'bir kurye'} kaydetti. Kuryenin içeri alınması için sakin portalından onaylayın veya reddedin.` },
          { kind: 'rows', rows: [['Bağımsız bölüm', unit], ...(company ? [['Firma', company] as [string, string]] : []), ['Yanıt için son saat', formatDateTime(d.respondBy, true)]] },
          { kind: 'note', text: `Süresi içinde yanıt verilmezse istek düşer ve kurye içeri alınmaz. Onayınız ${durationText(COURIER_APPROVAL_VALID_MINUTES)} geçerlidir.` },
        ],
        cta: { label: 'Onayla veya reddet', path: 'ziyaretci' },
      };
    }
    case 'gate_guest_entered': {
      const single = d.entryMode === 'single';
      return {
        subject: `Misafiriniz giriş yaptı - ${unit}`,
        heading: 'Misafir girişi kaydedildi',
        preheader: `${formatDateTime(d.enteredAt)} - ${unit}`,
        blocks: [
          { kind: 'p', text: `${unit} için oluşturduğunuz misafir geçişiyle güvenlikten giriş yapıldı.` },
          {
            kind: 'rows',
            rows: [
              ['Giriş', formatDateTime(d.enteredAt)],
              ['Geçiş türü', single ? 'Tek girişlik' : `Çok girişli (${num(d.entryCount)}. giriş)`],
              ['Geçerlilik sonu', formatDate(d.validUntil)],
              ['Bağımsız bölüm', unit],
            ],
          },
          { kind: 'note', text: single ? 'Tek girişlik geçiş kullanıldı; yeni bir ziyaret için yeni geçiş oluşturun. Bu girişi beklemiyorsanız güvenliğe haber verin.' : 'Bu girişi beklemiyorsanız geçişi portaldan iptal edin ve güvenliğe haber verin.' },
        ],
        cta: { label: 'Geçişlerimi görüntüle', path: 'ziyaretci' },
      };
    }
    case 'reservation_approved':
    case 'reservation_rejected':
    case 'reservation_cancelled':
      return reservationSpec(n, ctx);
    case 'assembly_called':
      return assemblyCallSpec(n);
    case 'assembly_cancelled':
    case 'assembly_rescheduled':
      return assemblyNoticeSpec(n);
    case 'tender_published':
    case 'tender_decided':
    case 'tender_cancelled':
    case 'tender_replied':
      return tenderSpec(n);
    case 'restructure_requested':
    case 'restructure_approved':
    case 'restructure_rejected':
      return restructureSpec(n, ctx);
    default:
      return undefined;
  }
}

/** Yapilandirma talebi: yeni talep (yonetim), onay / ret (talebi acan sakin). Sakin adi ve notu yok. */
function restructureSpec(n: Notification, ctx: EmailContext): Spec {
  const d = n.data;
  const unit = ctx.unitLabel(str(d.unitId));
  const party = d.liableParty === 'owner' ? 'Kat maliki' : 'Sakin (oturan)';
  if (n.template === 'restructure_requested') {
    return {
      subject: `Yeni yapılandırma talebi - ${unit}`,
      heading: 'Yeni borç yapılandırma talebi',
      preheader: `${unit}: ${num(d.installments)} taksit, yaklaşık ${formatTL(num(d.total))}`,
      blocks: [
        { kind: 'p', text: `${unit} için gecikmiş borcun taksitlendirilmesi talep edildi. Talebi olduğu gibi veya değişiklikle onaylayabilir ya da gerekçe yazarak reddedebilirsiniz.` },
        {
          kind: 'rows',
          rows: [
            ['Bağımsız bölüm', unit],
            ['Cari', party],
            ['İstenen taksit', `${num(d.installments)} taksit`],
            ['Tahmini toplam', formatTL(num(d.total))],
            ['Tahmini aylık taksit', formatTL(num(d.installmentAmount))],
          ],
        },
        { kind: 'note', text: 'Tutarlar talep anındaki tahmindir; onayda plan güncel borçtan yeniden hesaplanır. Vade farkı uygulanmaz.' },
      ],
      cta: { label: 'Talebi incele', path: '../admin/finance?tab=plans' },
    };
  }
  if (n.template === 'restructure_approved') {
    const changed = d.changed === 'true';
    return {
      subject: 'Yapılandırma talebiniz onaylandı',
      heading: 'Taksit planınız oluşturuldu',
      preheader: `${num(d.installments)} taksit${d.firstDueDate ? `, ilk taksit ${formatDate(d.firstDueDate)}` : ''}`,
      blocks: [
        {
          kind: 'p',
          text: changed
            ? `${unit} için yapılandırma talebiniz yönetim tarafından değişiklikle onaylandı (istenen ${num(d.requestedInstallments)} taksit).`
            : `${unit} için yapılandırma talebiniz onaylandı.`,
        },
        {
          kind: 'rows',
          rows: [
            ['Taksit sayısı', `${num(d.installments)} taksit`],
            ...(d.firstDueDate ? [['İlk taksit vadesi', formatDate(d.firstDueDate)] as [string, string]] : []),
            ...(typeof d.total === 'number' ? [['Plan toplamı', formatTL(d.total)] as [string, string]] : []),
          ],
        },
        { kind: 'note', text: 'Taksitlerinizi vadesinde ödediğiniz sürece yeni gecikme tazminatı yalnızca geciken taksitin anapara payına işler. Planın ayrıntıları Borçlarım ekranındadır.' },
      ],
      cta: { label: 'Taksit planımı görüntüle', path: 'dues' },
    };
  }
  const reason = str(d.reason);
  return {
    subject: 'Yapılandırma talebiniz reddedildi',
    heading: 'Yapılandırma talebiniz reddedildi',
    preheader: unit,
    blocks: [
      { kind: 'p', text: `${unit} için yapılandırma talebiniz yönetim tarafından reddedildi.` },
      ...(reason ? [{ kind: 'p' as const, text: `Gerekçe: ${reason}` }] : []),
      { kind: 'note', text: 'Sorularınız için yönetimle iletişime geçebilir veya Borçlarım ekranından yeni bir talep oluşturabilirsiniz.' },
    ],
    cta: { label: 'Borçlarımı görüntüle', path: 'dues' },
  };
}

/** Ihale: sakinlerle paylasim, karar ve yayindan sonra iptal (uyeler); soruya yonetim yaniti (soran sakin). */
function tenderSpec(n: Notification): Spec {
  const d = n.data;
  const title = str(d.title) || 'İhale';
  const id = str(d.tenderId);
  const cta = { label: 'İhaleyi görüntüle', path: id ? `ihale/${encodeURIComponent(id)}` : 'ihale' };
  if (n.template === 'tender_published') {
    const count = num(d.quoteCount);
    const lowest = typeof d.lowestTotalKurus === 'number' ? formatTL(d.lowestTotalKurus) : undefined;
    return {
      subject: `İhale teklifleri paylaşıldı: ${title}`,
      heading: 'İhale teklifleri paylaşıldı',
      preheader: `${count} teklif${lowest ? `, en düşük ${lowest} (KDV dahil)` : ''}`,
      blocks: [
        { kind: 'p', text: `Yönetim "${title}" işi için alınan teklifleri sakinlerle paylaştı. Teklifleri yan yana inceleyebilir, belgelerini açabilir ve sorularınızı ihale sayfasından yönetime iletebilirsiniz.` },
        { kind: 'rows', rows: [['İş', title], ['Teklif sayısı', String(count)], ...(lowest ? [['En düşük teklif (KDV dahil)', lowest] as [string, string]] : [])] },
        ...(d.shortfall === 'true' ? [{ kind: 'note' as const, text: 'Asgari teklif sayısına ulaşılamadı; yönetimin gerekçesini ihale sayfasında görebilirsiniz.' }] : []),
      ],
      cta: { ...cta, label: 'Teklifleri incele' },
    };
  }
  if (n.template === 'tender_decided') {
    const supplier = str(d.supplierName);
    const total = formatTL(num(d.totalKurus));
    const reference = str(d.reference);
    const reason = str(d.reason);
    return {
      subject: `İhale sonuçlandı: ${title}`,
      heading: 'İhale karara bağlandı',
      preheader: `${supplier}, ${total} (KDV dahil)`,
      blocks: [
        { kind: 'p', text: `Sakinlerle paylaşılan "${title}" ihalesi karara bağlandı.` },
        { kind: 'rows', rows: [['Seçilen firma', supplier], ['Tutar (KDV dahil)', total], ...(reference ? [['Karar referansı', reference] as [string, string]] : [])] },
        ...(reason ? [{ kind: 'p' as const, text: `Gerekçe: ${reason}` }] : []),
      ],
      cta,
    };
  }
  if (n.template === 'tender_cancelled') {
    const reason = str(d.reason);
    return {
      subject: `İhale iptal edildi: ${title}`,
      heading: 'İhale iptal edildi',
      preheader: title,
      blocks: [
        { kind: 'p', text: `Sakinlerle paylaşılan "${title}" ihalesi yönetim tarafından iptal edildi.` },
        ...(reason ? [{ kind: 'p' as const, text: `Gerekçe: ${reason}` }] : []),
      ],
      cta,
    };
  }
  return {
    subject: `Sorunuz yanıtlandı: ${title}`,
    heading: 'Yönetim sorunuzu yanıtladı',
    preheader: title,
    blocks: [
      { kind: 'p', text: `"${title}" ihalesine yazdığınız soruya yönetim yanıt verdi.` },
      ...(str(d.reply) ? [{ kind: 'note' as const, text: `Yanıt: ${str(d.reply)}` }] : []),
      { kind: 'note', text: 'Tüm sorular ve yanıtlar ihale sayfasında diğer sakinlere adınız olmadan görünür.' },
    ],
    cta: { ...cta, label: 'Yanıtı görüntüle' },
  };
}

/** E-posta nezaketen gonderilir: KMK m.29'daki cagri usulunun yerine gecmez (README "Hukuki yorum"). */
export const ASSEMBLY_CALL_DISCLAIMER =
  'Bu e-posta bilgilendirme amaçlıdır; kanunda ve yönetim planında öngörülen çağrı usulünün (olağanüstü toplantıda imza karşılığı tebliğ veya taahhütlü mektup, Kat Mülkiyeti Kanunu m.29/2) yerine geçmez.';

/** Genel kurul cagrisi: tarih-saat (Istanbul), yer / baglanti, gundem ve (ilk toplantida) ikinci toplanti. */
function assemblyCallSpec(n: Notification): Spec {
  const d = n.data;
  const kind = d.kind === 'extraordinary' ? 'Olağanüstü' : 'Olağan';
  const second = d.secondMeeting === 'true';
  const agenda = Array.isArray(d.agenda) ? (d.agenda as NotificationItem[]).map((i) => i.label) : [];
  const when = formatDateTime(d.scheduledAt);
  const place: [string, string][] = [
    ['Tarih ve saat', `${when} (Türkiye saati)`],
    ...(str(d.location) ? [['Yer', str(d.location)] as [string, string]] : []),
    ...(str(d.onlineUrl) ? [['Çevrim içi bağlantı', str(d.onlineUrl)] as [string, string]] : []),
  ];
  const secondAt = str(d.secondMeetingAt);
  const secondPlace = [str(d.secondMeetingLocation), str(d.secondMeetingUrl)].filter(Boolean).join(' · ');
  return {
    subject: `${d.resend === 'true' ? 'Güncellenen çağrı: ' : ''}Kat malikleri kurulu toplantısı - ${when}`,
    heading: `${kind} kat malikleri kurulu toplantısı${second ? ' (ikinci toplantı)' : ''}`,
    preheader: `${when} · ${agenda.length} gündem maddesi`,
    blocks: [
      {
        kind: 'p',
        text: second
          ? 'İlk toplantıda yeter sayı sağlanamadığından kat malikleri kurulu aşağıdaki gündemle ikinci kez toplanacaktır. Bu toplantıda toplantı yeter sayısı aranmaz.'
          : 'Kat malikleri kurulu aşağıdaki gündemle toplanacaktır. Toplantıya kendiniz katılabilir veya yazılı vekaletnameyle temsil edilebilirsiniz.',
      },
      ...(d.resend === 'true' ? [{ kind: 'note' as const, text: 'Bu çağrı, daha önce gönderilen çağrının güncellenmiş halidir; önceki e-postayı dikkate almayınız.' }] : []),
      { kind: 'rows', rows: place },
      { kind: 'list', title: 'Gündem', items: agenda },
      ...(secondAt
        ? [
            {
              kind: 'p' as const,
              text: `İlk toplantıda yeter sayı sağlanamazsa ikinci toplantı ${formatDateTime(secondAt)} tarihinde${secondPlace ? ` (${secondPlace})` : ''} yapılacaktır; ikinci toplantıda toplantı yeter sayısı aranmaz (KMK m.29/3, m.30).`,
            },
          ]
        : []),
      { kind: 'note', text: ASSEMBLY_CALL_DISCLAIMER },
    ],
    cta: { label: 'Toplantı ayrıntıları', path: str(d.assemblyId) ? `genel-kurul/${encodeURIComponent(str(d.assemblyId))}` : 'genel-kurul' },
  };
}

/** Cagrisi gonderilmis toplantinin iptali veya ertelenmesi / yer degisikligi (cagri alicilarina). */
function assemblyNoticeSpec(n: Notification): Spec {
  const d = n.data;
  const kind = d.kind === 'extraordinary' ? 'Olağanüstü' : 'Olağan';
  const reason = str(d.reason);
  const cta = { label: 'Toplantı ayrıntıları', path: str(d.assemblyId) ? `genel-kurul/${encodeURIComponent(str(d.assemblyId))}` : 'genel-kurul' };
  if (n.template === 'assembly_cancelled') {
    const when = formatDateTime(d.scheduledAt);
    return {
      subject: `İptal: kat malikleri kurulu toplantısı - ${when}`,
      heading: `${kind} kat malikleri kurulu toplantısı iptal edildi`,
      preheader: `${when} tarihli toplantı yapılmayacak`,
      blocks: [
        { kind: 'p', text: `${when} (Türkiye saati) tarihinde yapılması planlanan ${kind.toLocaleLowerCase('tr')} kat malikleri kurulu toplantısı yönetim tarafından iptal edildi. Bu tarihte toplantı yapılmayacaktır.` },
        ...(reason ? [{ kind: 'p' as const, text: `Gerekçe: ${reason}` }] : []),
        { kind: 'note', text: 'Yeni bir toplantı yapılacaksa ayrıca çağrı gönderilir. Bu e-posta bilgilendirme amaçlıdır.' },
      ],
      cta,
    };
  }
  const when = formatDateTime(d.scheduledAt);
  const prev = formatDateTime(d.previousScheduledAt);
  const timeChanged = d.timeChanged === 'true';
  const rows: [string, string][] = [
    ...(timeChanged ? [['Önceki tarih', `${prev} (Türkiye saati)`] as [string, string]] : []),
    ['Yeni tarih ve saat', `${when} (Türkiye saati)`],
    ...(str(d.location) ? [['Yer', str(d.location)] as [string, string]] : []),
    ...(str(d.onlineUrl) ? [['Çevrim içi bağlantı', str(d.onlineUrl)] as [string, string]] : []),
  ];
  return {
    subject: `${timeChanged ? 'Ertelendi' : 'Yer değişikliği'}: kat malikleri kurulu toplantısı - ${when}`,
    heading: `${kind} kat malikleri kurulu toplantısı ${timeChanged ? 'ertelendi' : 'yeri değişti'}`,
    preheader: timeChanged ? `${prev} yerine ${when}` : `Yeni yer: ${str(d.location) || str(d.onlineUrl)}`,
    blocks: [
      {
        kind: 'p',
        text: timeChanged
          ? `${prev} tarihli kat malikleri kurulu toplantısı yönetim tarafından ertelendi. Toplantı aşağıdaki tarihte yapılacaktır.`
          : 'Kat malikleri kurulu toplantısının yeri değişti; toplantı aşağıdaki yerde yapılacaktır.',
      },
      { kind: 'rows', rows },
      ...(reason ? [{ kind: 'p' as const, text: `Gerekçe: ${reason}` }] : []),
      { kind: 'note', text: ASSEMBLY_CALL_DISCLAIMER },
    ],
    cta,
  };
}

/** Iptal edilen rezervasyonda ucretin durumu (yonetim iptali). */
function refundText(status: string, amount: string): string | undefined {
  switch (status) {
    case 'reversed':
      return `${amount} iade edildi (ters kayıt hesabınıza işlendi)`;
    case 'reversal_pending':
      return `${amount} iadesi yönetim tarafından işleniyor`;
    case 'resolved_manually':
      return `${amount} yönetim tarafından ayrıca düzeltildi`;
    case 'void':
    case 'pending':
      return 'Ücret tahakkuk edilmemişti; ödeme gerekmez';
    default:
      return undefined;
  }
}

/** Ortak alan rezervasyonu: yonetimin onayi, reddi ve iptali (rezervasyonu yapan sakine). */
function reservationSpec(n: Notification, ctx: EmailContext): Spec {
  const d = n.data;
  const unit = ctx.unitLabel(str(d.unitId));
  const facility = str(d.facilityName) || 'Ortak alan';
  const when = `${formatDate(d.date)} ${formatDateTime(d.start, true)}-${formatDateTime(d.end, true)}`;
  const fee = num(d.feeKurus);
  const rows: [string, string][] = [
    ['Ortak alan', facility],
    ['Tarih', formatDate(d.date)],
    ['Saat', `${formatDateTime(d.start, true)}-${formatDateTime(d.end, true)}`],
    ['Bağımsız bölüm', unit],
  ];
  const reason = str(d.reason);
  const cta = { label: 'Rezervasyonlarım', path: 'rezervasyon' };
  if (n.template === 'reservation_approved') {
    return {
      subject: `Rezervasyonunuz onaylandı: ${facility} ${formatDate(d.date)}`,
      heading: 'Rezervasyonunuz onaylandı',
      preheader: `${facility}, ${when}`,
      blocks: [
        { kind: 'p', text: `${unit} adına ${facility} için yaptığınız rezervasyon yönetim tarafından onaylandı.` },
        { kind: 'rows', rows: [...rows, ...(fee > 0 ? [['Ücret', `${formatTL(fee)} (hesabınıza tahakkuk edildi)`] as [string, string]] : [])] },
        { kind: 'note', text: 'Planınız değişirse rezervasyonu portaldan, alanın iptal süresi dolmadan iptal edebilirsiniz.' },
      ],
      cta,
    };
  }
  if (n.template === 'reservation_rejected') {
    return {
      subject: `Rezervasyonunuz reddedildi: ${facility} ${formatDate(d.date)}`,
      heading: 'Rezervasyon talebiniz reddedildi',
      preheader: `${facility}, ${when}`,
      blocks: [
        { kind: 'p', text: `${unit} adına ${facility} için yaptığınız rezervasyon talebi yönetim tarafından reddedildi.` },
        { kind: 'rows', rows },
        ...(reason ? [{ kind: 'p' as const, text: `Gerekçe: ${reason}` }] : []),
        { kind: 'note', text: `Seçtiğiniz saat aralığı yeniden rezervasyona açıldı.${fee > 0 ? ' Ücret tahakkuk edilmedi.' : ''}` },
      ],
      cta: { ...cta, label: 'Yeni rezervasyon yap' },
    };
  }
  const refund = fee > 0 ? refundText(str(d.feeStatus), formatTL(fee)) : undefined;
  return {
    subject: `Rezervasyonunuz iptal edildi: ${facility} ${formatDate(d.date)}`,
    heading: 'Rezervasyonunuz iptal edildi',
    preheader: `${facility}, ${when}`,
    blocks: [
      { kind: 'p', text: `${unit} adına ${facility} için yaptığınız rezervasyon yönetim tarafından iptal edildi.` },
      { kind: 'rows', rows: [...rows, ...(refund ? [['Ücret', refund] as [string, string]] : [])] },
      ...(reason ? [{ kind: 'p' as const, text: `Gerekçe: ${reason}` }] : []),
      ...(str(d.feeStatus) === 'reversal_pending' && fee > 0 ? [{ kind: 'note' as const, text: 'İade tamamlandığında tutar hesabınızda alacak olarak görünür; sorularınız için yönetimle iletişime geçebilirsiniz.' }] : []),
    ],
    cta,
  };
}

const TICKET_STATUS_TEXT: Record<string, string> = {
  open: 'Açık',
  assigned: 'Atandı',
  in_progress: 'İşleme alındı',
  on_hold: 'Beklemeye alındı',
  resolved: 'Çözüldü',
  closed: 'Kapandı',
  cancelled: 'İptal edildi',
};
const PRIORITY_TEXT: Record<string, string> = { low: 'Düşük', normal: 'Normal', high: 'Yüksek', urgent: 'Acil' };

/** Talep durum bildirimindeki yeni durumun metni (e-posta ve push ortak). */
export function ticketStatusText(d: Notification['data']): string {
  const to = str(d.to);
  if (to === 'cancelled') return d.cancelKind === 'rejected' ? 'Yönetim tarafından reddedildi' : 'Geri çekildi';
  if (to === 'closed') return d.closeKind === 'auto' ? 'Süre dolduğu için kapandı' : d.closeKind === 'confirmed' ? 'Onaylanarak kapandı' : 'Yönetim tarafından kapatıldı';
  return TICKET_STATUS_TEXT[to] ?? to;
}

const items = (v: unknown): NotificationItem[] => (Array.isArray(v) ? (v as NotificationItem[]).filter((x) => x && typeof x.label === 'string') : []);

/** O1-3: gunluk operasyon ozeti (yonetim / gorevli). */
function digestSpec(n: Notification): Spec {
  const d = n.data;
  const sla = items(d.sla);
  const due = items(d.due);
  const overdue = items(d.overdue);
  const autoClosed = num(d.autoClosed);
  // v2: ekipman garanti / sozlesme / periyodik kontrol tarihleri (yalnizca yonetim ozetinde).
  // Sayi olaydaki 100 kalem sinirindan once hesaplanir (`equipmentCount`).
  const equipment = items(d.equipment);
  const equipmentCount = equipment.length ? Math.max(num(d.equipmentCount), equipment.length) : 0;
  const equipmentTitle = d.equipmentWeekly
    ? 'Ekipman: garanti, sözleşme, periyodik kontrol (haftalık tam liste: yaklaşan ve dolmuş)'
    : 'Ekipman: garanti, sözleşme, periyodik kontrol (önümüzdeki ve son 30 gün)';
  const parts = [
    sla.length ? `${sla.length} talep SLA süresini aştı` : '',
    overdue.length ? `${overdue.length} bakım gecikti` : '',
    due.length ? `${due.length} bakım yaklaşıyor` : '',
    autoClosed ? `${autoClosed} talep otomatik kapandı` : '',
    equipmentCount ? `${equipmentCount} ekipman tarihi yaklaştı veya doldu` : '',
  ].filter(Boolean);
  const table = (title: string, list: NotificationItem[]): Block[] =>
    list.length ? [{ kind: 'table', head: [title, ''], rows: list.slice(0, 25).map((i) => [i.label, i.detail ?? '']) as [string, string][] }] : [];
  return {
    subject: `Günlük özet ${formatDate(d.date)}: ${parts.join(', ') || 'bekleyen iş yok'}`,
    heading: 'Günlük arıza ve bakım özeti',
    preheader: parts.join(' · '),
    blocks: [
      { kind: 'p', text: `${formatDate(d.date)} itibarıyla: ${parts.join(', ')}.` },
      ...table('SLA süresi aşılan talepler', sla),
      ...table('Geciken bakımlar', overdue),
      ...table('Yaklaşan bakımlar (3 gün)', due),
      ...table(equipmentTitle, equipment),
      ...(sla.length > 25 || due.length > 25 || overdue.length > 25 || equipmentCount > 25 ? [{ kind: 'note', text: 'Listenin tamamı yönetim panelinde.' } as Block] : []),
    ],
    cta: { label: 'Arıza ve bakım ekranını aç', path: '../admin/tickets' },
  };
}

/** Arka plan toplu isinin turu (e-posta ve push). */
export const BULK_JOB_KIND_TEXT: Record<string, string> = {
  dues_bulk: 'Toplu aidat tahakkuku',
  meter_posting: 'Sayaç dönemi onayı (tahakkuk)',
  meter_reversal: 'Sayaç dönemi geri alma',
};

/** Bildirim devami: toplu isin bitis ozeti (isi baslatan yonetici). */
function bulkJobSpec(n: Notification): Spec {
  const d = n.data;
  const kind = BULK_JOB_KIND_TEXT[str(d.kind)] ?? 'Toplu işlem';
  const label = str(d.label);
  const title = label ? `${kind}: ${label}` : kind;
  const fmt = (v: unknown) => num(v).toLocaleString('tr-TR');
  const status = str(d.status);
  const head =
    status === 'failed'
      ? { subject: `Toplu işlem tamamlanamadı - ${title}`, heading: 'Toplu işlem tamamlanamadı', text: `${title} işlemi tamamlanamadı. Yazılmış kalemler korunur; yönetim panelinden "Tekrar dene" ile kaldığı yerden devam edebilirsiniz.` }
      : status === 'completed_with_errors'
        ? { subject: `Toplu işlem hatalarla bitti - ${title}`, heading: 'Toplu işlem hatalarla bitti', text: `${title} işlemi bitti; bazı bölümler yazılamadı. Hatalı bölümleri yönetim panelinde görüp "Tekrar dene" ile yeniden deneyebilirsiniz.` }
        : { subject: `Toplu işlem tamamlandı - ${title}`, heading: 'Toplu işlem tamamlandı', text: `${title} işlemi başarıyla tamamlandı.` };
  const rows: [string, string][] = [
    ['İşlem', kind],
    ...(label ? [['Dönem / açıklama', label] as [string, string]] : []),
    ['Toplam bölüm', fmt(d.total)],
    ['Başarılı', fmt(d.succeeded)],
    ['Hatalı', fmt(d.failed)],
    ['Bu işlemle yeni yazılan', fmt(d.written)],
  ];
  return {
    subject: head.subject,
    heading: head.heading,
    preheader: `${fmt(d.succeeded)} başarılı, ${fmt(d.failed)} hatalı`,
    blocks: [
      { kind: 'p', text: head.text },
      { kind: 'rows', rows },
      ...(status === 'failed' && str(d.errorMessage) ? [{ kind: 'note', text: `Hata: ${str(d.errorMessage)}` } as Block] : []),
    ],
    cta: { label: 'İşlemi görüntüle', path: `../${str(d.adminPath) || 'admin'}` },
  };
}

function ticketSpec(n: Notification, ctx: EmailContext): Spec | undefined {
  const d = n.data;
  const number = str(d.number);
  const title = str(d.title);
  const where = d.unitId ? ctx.unitLabel(str(d.unitId)) : str(d.area) || 'Ortak alan';
  const category = TICKET_CATEGORY_LABELS[str(d.category) as keyof typeof TICKET_CATEGORY_LABELS] ?? 'Diğer';
  const admin = d.link === 'admin';
  const cta = { label: 'Talebi görüntüle', path: admin ? `../admin/tickets/${str(d.ticketId)}` : `talepler/${str(d.ticketId)}` };
  const rows: [string, string][] = [['Talep no', number], ['Konu', title], ['Yer', where], ['Kategori', category]];
  switch (n.template) {
    case 'ticket_created':
      return {
        subject: `${d.priority === 'urgent' ? 'ACİL - ' : ''}Yeni arıza / talep: ${number} ${title}`,
        heading: 'Yeni arıza / talep',
        preheader: `${where} - ${title}`,
        blocks: [
          { kind: 'p', text: admin ? 'Yeni bir arıza / talep bildirildi.' : `${where} için bir arıza / talep bildirildi. Kat maliki olarak bilginize sunulur.` },
          { kind: 'rows', rows: [...rows, ['Öncelik', PRIORITY_TEXT[str(d.priority)] ?? 'Normal']] },
        ],
        cta,
      };
    case 'ticket_assigned':
      return {
        subject: `Size iş atandı: ${number} ${title}`,
        heading: 'Size yeni bir iş atandı',
        preheader: `${where} - ${title}`,
        blocks: [{ kind: 'p', text: 'Aşağıdaki talep size atandı. Ayrıntıları ve fotoğrafları İşlerim ekranında görebilirsiniz.' }, { kind: 'rows', rows: [...rows, ['Öncelik', PRIORITY_TEXT[str(d.priority)] ?? 'Normal']] }],
        cta,
      };
    case 'ticket_resolved':
      return {
        subject: `Talebiniz çözüldü: ${number}`,
        heading: 'Talebiniz çözüldü',
        preheader: `${title} - lütfen onaylayın`,
        blocks: [
          { kind: 'p', text: 'Bildirdiğiniz arıza / talep çözüldü olarak işaretlendi. Sorun giderildiyse lütfen onaylayın; devam ediyorsa yeniden açabilirsiniz.' },
          { kind: 'rows', rows },
          { kind: 'note', text: 'Onaylanmayan talepler belirlenen süre sonunda otomatik olarak kapanır.' },
        ],
        cta: { ...cta, label: 'Onayla veya yeniden aç' },
      };
    case 'ticket_reopened':
      return {
        subject: `Talep yeniden açıldı: ${number}`,
        heading: 'Talep yeniden açıldı',
        preheader: title,
        blocks: [{ kind: 'p', text: 'Çözüldü olarak işaretlenen talep yeniden açıldı.' }, { kind: 'rows', rows }],
        cta,
      };
    case 'ticket_comment':
      return {
        subject: `Talebe yeni mesaj: ${number}`,
        heading: 'Talebe yeni mesaj',
        preheader: title,
        blocks: [{ kind: 'p', text: 'Aşağıdaki talebe yeni bir mesaj eklendi. Mesajı talep ekranında okuyabilirsiniz.' }, { kind: 'rows', rows }],
        cta,
      };
    case 'ticket_status': {
      const text = ticketStatusText(d);
      return {
        subject: `Talep durumu: ${number} - ${text}`,
        heading: 'Talep durumu güncellendi',
        preheader: `${title}: ${text}`,
        blocks: [{ kind: 'p', text: `Talebin yeni durumu: ${text}.` }, { kind: 'rows', rows }],
        cta,
      };
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Uretim (tek escape noktasi)
// ---------------------------------------------------------------------------

const C = { text: '#1f2937', muted: '#6b7280', line: '#e5e7eb', bg: '#f4f5f7', brand: '#1d4ed8' };

function blockHtml(b: Block): string {
  const e = escapeHtml;
  switch (b.kind) {
    case 'p':
      return `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:${C.text}">${e(b.text)}</p>`;
    case 'note':
      return `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:${C.muted}">${e(b.text)}</p>`;
    case 'rows':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 8px">${b.rows
        .map(
          ([l, v]) =>
            `<tr><td style="padding:8px 0;border-bottom:1px solid ${C.line};font-size:14px;color:${C.muted}">${e(l)}</td><td align="right" style="padding:8px 0;border-bottom:1px solid ${C.line};font-size:14px;font-weight:600;color:${C.text}">${e(v)}</td></tr>`,
        )
        .join('')}</table>`;
    case 'table': {
      const head = `<tr><th align="left" style="padding:8px 0;border-bottom:2px solid ${C.line};font-size:13px;color:${C.muted};font-weight:600">${e(b.head[0])}</th><th align="right" style="padding:8px 0;border-bottom:2px solid ${C.line};font-size:13px;color:${C.muted};font-weight:600">${e(b.head[1])}</th></tr>`;
      const rows = b.rows
        .map(([a, v]) => `<tr><td style="padding:8px 0;border-bottom:1px solid ${C.line};font-size:14px;color:${C.text}">${e(a)}</td><td align="right" style="padding:8px 0;border-bottom:1px solid ${C.line};font-size:14px;color:${C.text}">${e(v)}</td></tr>`)
        .join('');
      const total = b.total
        ? `<tr><td style="padding:10px 0;font-size:15px;font-weight:700;color:${C.text}">${e(b.total[0])}</td><td align="right" style="padding:10px 0;font-size:15px;font-weight:700;color:${C.text}">${e(b.total[1])}</td></tr>`
        : '';
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px">${head}${rows}${total}</table>`;
    }
    case 'list':
      return `<p style="margin:16px 0 8px;font-size:14px;font-weight:600;color:${C.text}">${e(b.title)}</p><ol style="margin:0 0 16px;padding-left:22px;font-size:15px;line-height:1.55;color:${C.text}">${b.items
        .map((i) => `<li style="margin:0 0 4px">${e(i)}</li>`)
        .join('')}</ol>`;
  }
}

function blockText(b: Block): string {
  switch (b.kind) {
    case 'p':
    case 'note':
      return b.text;
    case 'rows':
      return b.rows.map(([l, v]) => `${l}: ${v}`).join('\n');
    case 'table':
      return [...b.rows.map(([a, v]) => `- ${a}: ${v}`), ...(b.total ? [`${b.total[0]}: ${b.total[1]}`] : [])].join('\n');
    case 'list':
      return [`${b.title}:`, ...b.items.map((i, n) => `${n + 1}. ${i}`)].join('\n');
  }
}

export const FOOTER_TEXT =
  'Bu e-posta, yönetiminiz adına YÖNESİST tarafından otomatik olarak gönderilmiştir; lütfen yanıtlamayınız. E-posta bildirimlerini hesabınızdaki bildirim tercihlerinden kapatabilirsiniz.';

/** Bildirimi e-postaya donusturur; sablonu olmayan bildirimde `undefined`. */
export function renderEmail(n: Notification, ctx: EmailContext): RenderedEmail | undefined {
  const s = spec(n, ctx);
  if (!s) return undefined;
  const e = escapeHtml;
  const subject = cleanSubject(`${s.subject} - ${ctx.siteName}`);
  const greeting = ctx.recipientName ? `Sayın ${ctx.recipientName},` : 'Merhaba,';
  const cta = s.cta ? safeUrl(ctx.portalUrl, s.cta.path) : undefined;

  const html = [
    '<!doctype html>',
    '<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta name="color-scheme" content="light"><title>${e(subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:${C.bg};font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${C.text}">`,
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${e(s.preheader)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:24px 12px">`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px">',
    `<tr><td style="padding:18px 24px;border-bottom:1px solid ${C.line};font-size:13px;font-weight:600;color:${C.muted}">${e(ctx.siteName)}</td></tr>`,
    '<tr><td style="padding:24px">',
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:${C.text}">${e(s.heading)}</h1>`,
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:${C.text}">${e(greeting)}</p>`,
    ...s.blocks.map(blockHtml),
    cta
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0"><tr><td style="border-radius:6px;background:${C.brand}"><a href="${e(cta)}" style="display:inline-block;padding:12px 20px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${e(s.cta!.label)}</a></td></tr></table>`
      : '',
    '</td></tr>',
    `<tr><td style="padding:16px 24px;border-top:1px solid ${C.line};font-size:12px;line-height:1.5;color:${C.muted}">${e(FOOTER_TEXT)}</td></tr>`,
    '</table></td></tr></table></body></html>',
  ].join('');

  const text = [
    ctx.siteName,
    '',
    s.heading,
    '',
    greeting,
    '',
    ...s.blocks.flatMap((b) => [blockText(b), '']),
    ...(cta ? [`${s.cta!.label}: ${cta}`, ''] : []),
    '--',
    FOOTER_TEXT,
  ].join('\n');

  return { subject, html, text, preheader: s.preheader };
}
