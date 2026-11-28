import type { IsoDate } from '../core/types.js';
import { addDays, daysBetween, invoiceAmounts, periodBounds, priceLines } from './pricing.js';
import { type InvoiceLine, type Subscription, type SubscriptionInvoice, type SubscriptionStatus, subscriptionGsi } from './types.js';

/**
 * Abonelik durum makinesi (SAF; tarih bazli). Zamanlanmis gunluk is ve platform islemleri ayni
 * fonksiyonlari kullanir; sonuc (yeni kayit + kesilecek faturalar + olaylar) servis tarafindan
 * TEK atomik yazimla (abonelik + faturalar + numara sayaci + outbox + denetim) kaydedilir.
 *
 *   trial      -> active     deneme bitti (son gunden sonraki gun): ilk donem baslar, fatura kesilir
 *   active     -> past_due   odenmemis faturanin son odeme gunu gecti
 *   past_due   -> suspended  `pastDueSince + graceDays` gunu geldi (salt okunur)
 *   past_due   -> active     odenmemis vadesi gecmis fatura kalmadi
 *   suspended  -> active     (odeme nedeniyle askidaysa) odenmemis vadesi gecmis fatura kalmadi
 *   *          -> cancelled  yalnizca platform (salt okunur; veri disa aktarilabilir)
 * Donem yenileme `active` / `past_due` iken gun donem sonunu gecince olur (askida yeni fatura yok).
 * Ayni gun ikinci kez calismak hicbir sey degistirmez (bildirim isaretleri, fatura anahtari = donem basi).
 */

export type InvoiceDraft = {
  invoiceId: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  issueDate: IsoDate;
  dueDate: IsoDate;
  unitCount: number;
  lines: InvoiceLine[];
  netKurus: number;
  vatRateBps: number;
  vatKurus: number;
  totalKurus: number;
};

export type MachineEvent =
  | { type: 'SUBSCRIPTION_TRIAL_ENDING'; eventId: string; payload: { trialEndsAt: IsoDate; daysLeft: number; planName: string } }
  | { type: 'SUBSCRIPTION_PAST_DUE'; eventId: string; payload: { pastDueSince: IsoDate; suspendOn: IsoDate; overdueTotalKurus: number; invoiceCount: number } }
  | { type: 'SUBSCRIPTION_SUSPENDED'; eventId: string; payload: { suspendedAt: IsoDate; reason: 'non_payment' | 'manual' } }
  | { type: 'SUBSCRIPTION_REACTIVATED'; eventId: string; payload: { reactivatedOn: IsoDate; from: SubscriptionStatus } }
  | { type: 'SUBSCRIPTION_CANCELLED'; eventId: string; payload: { cancelledAt: IsoDate } };

export type Transition = { from: SubscriptionStatus; to: SubscriptionStatus; reason: string };

export type AdvanceResult = {
  sub: Subscription;
  invoices: InvoiceDraft[];
  events: MachineEvent[];
  transitions: Transition[];
  /** Kayit degisti mi (yazim gerekir mi)? */
  changed: boolean;
};

export type OpenInvoice = Pick<SubscriptionInvoice, 'invoiceId' | 'dueDate' | 'status' | 'totalKurus'>;

export type AdvanceInput = {
  sub: Subscription;
  day: IsoDate;
  /** Abonelik faturalari (en azindan odenmemis olanlar; kesilmis donemler tekrar kesilmez). */
  invoices: readonly OpenInvoice[];
  /** Yeni donemin bolum anlik goruntusu (aktif bolum sayisi). */
  unitCount: number;
};

/** Ortak calisma durumu: `advance` ve `applyAction` ayni adimlari paylasir. */
function builder(input: AdvanceInput) {
  const sub: Subscription = structuredClone(input.sub);
  const invoices: InvoiceDraft[] = [];
  const events: MachineEvent[] = [];
  const transitions: Transition[] = [];
  const open: OpenInvoice[] = input.invoices.filter((i) => i.status === 'issued').map((i) => ({ ...i }));
  const known = new Set(input.invoices.map((i) => i.invoiceId));

  const move = (to: SubscriptionStatus, reason: string) => {
    if (sub.status === to) return;
    transitions.push({ from: sub.status, to, reason });
    sub.status = to;
  };

  /** Yeni donem: taban yoksa `start` taban olur; bedeli varsa fatura taslagi. */
  const startPeriod = (start: IsoDate) => {
    if (!sub.billingAnchor || sub.periodIndex === undefined) {
      sub.billingAnchor = start;
      sub.periodIndex = 0;
    } else {
      sub.periodIndex += 1;
    }
    const bounds = periodBounds(sub.billingAnchor, sub.periodIndex, sub.billingPeriod);
    sub.currentPeriodStart = bounds.start;
    sub.currentPeriodEnd = bounds.end;
    sub.unitCountSnapshot = input.unitCount;
    const lines = priceLines(sub.plan, sub.billingPeriod, input.unitCount);
    const amounts = invoiceAmounts(lines, sub.plan.pricing.vatRateBps);
    // Bedelsiz plan (pilot / ucretsiz): fatura kesilmez, vade de olusmaz.
    if (amounts.totalKurus <= 0 || known.has(bounds.start)) return;
    known.add(bounds.start);
    // Fatura islendigi GUN kesilir (gecmis tarihli fatura yok; numaralar yil serisinde tarih sirasinda);
    // son odeme en erken bugun + odeme suresi.
    const issueDate = bounds.start > input.day ? bounds.start : input.day;
    const draft: InvoiceDraft = {
      invoiceId: bounds.start,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      issueDate,
      dueDate: addDays(issueDate, sub.paymentTermDays),
      unitCount: input.unitCount,
      lines,
      ...amounts,
    };
    invoices.push(draft);
    open.push({ invoiceId: draft.invoiceId, dueDate: draft.dueDate, status: 'issued', totalKurus: draft.totalKurus });
  };

  /**
   * Askidan / iptalden donuste (`resumeFrom`) suresi dolmus donem YENIDEN TABANLANIR: askida gecen
   * donemler faturalanmaz, yeni donem donus gununden baslar. Hic faturalanmamis abonelik de oradan baslar.
   */
  const renew = (day: IsoDate) => {
    if (sub.resumeFrom) {
      const from = sub.resumeFrom;
      delete sub.resumeFrom;
      if (!sub.currentPeriodEnd || sub.currentPeriodEnd < from) {
        delete sub.billingAnchor;
        delete sub.periodIndex;
        startPeriod(from);
      }
    }
    for (let guard = 0; guard < 36 && sub.currentPeriodEnd && day > sub.currentPeriodEnd; guard++) startPeriod(addDays(sub.currentPeriodEnd, 1));
  };

  /** Donus gunu: donem bitmisse veya hic donem yoksa yeniden tabanlama isareti. */
  const markResume = (day: IsoDate) => {
    if (!sub.currentPeriodEnd || sub.currentPeriodEnd < day) sub.resumeFrom = day;
  };

  /**
   * Otomasyon KAPALIYKEN odeme / iptal sonrasi: yalnizca odemeyle dogrudan cozulen durum (gecikme
   * -> aktif, odeme nedeniyle askida -> aktif); donem yenileme, fatura, gecikme / askiya alma ve
   * bildirim YOK.
   */
  const settlePayments = (day: IsoDate) => {
    if (open.some((i) => i.dueDate < day)) return;
    if (sub.status === 'past_due') {
      move('active', 'paid');
      delete sub.pastDueSince;
    }
    if (sub.status === 'suspended' && sub.suspendedReason === 'non_payment') {
      move('active', 'paid');
      delete sub.pastDueSince;
      delete sub.suspendedAt;
      delete sub.suspendedReason;
      markResume(day);
    }
  };

  /** Gunluk adimlar (deneme -> donem -> vade). */
  const settle = (day: IsoDate) => {
    const apt = sub.apartmentId;
    if (sub.status === 'trial' && sub.trialEndsAt) {
      const left = daysBetween(day, sub.trialEndsAt);
      const notices = { ...(sub.notices ?? {}) };
      if (left >= 0 && left <= 1 && !notices.trial1) {
        events.push({ type: 'SUBSCRIPTION_TRIAL_ENDING', eventId: `SUBSCRIPTION_TRIAL_ENDING:${apt}:${sub.trialEndsAt}:1`, payload: { trialEndsAt: sub.trialEndsAt, daysLeft: left, planName: sub.plan.name } });
        notices.trial1 = day;
        notices.trial7 ??= day;
      } else if (left > 1 && left <= 7 && !notices.trial7) {
        events.push({ type: 'SUBSCRIPTION_TRIAL_ENDING', eventId: `SUBSCRIPTION_TRIAL_ENDING:${apt}:${sub.trialEndsAt}:7`, payload: { trialEndsAt: sub.trialEndsAt, daysLeft: left, planName: sub.plan.name } });
        notices.trial7 = day;
      }
      if (notices.trial1 !== sub.notices?.trial1 || notices.trial7 !== sub.notices?.trial7) sub.notices = notices;
      if (day > sub.trialEndsAt) {
        move('active', 'trial_ended');
        startPeriod(addDays(sub.trialEndsAt, 1));
      }
    }

    if (sub.status === 'active' || sub.status === 'past_due') renew(day);

    const overdue = open.filter((i) => i.dueDate < day);
    const firstOverdue = overdue.map((i) => addDays(i.dueDate, 1)).sort()[0];
    if (sub.status === 'active' && firstOverdue) {
      // Ek sure gecikmenin TESPIT edildigi (bildirildigi) gunden baslar: gunluk is kesintiye ugrasa
      // veya elle yeniden acilsa da yonetim bildirimden sonra tam `graceDays` alir.
      const since = day;
      move('past_due', 'invoice_overdue');
      sub.pastDueSince = since;
      events.push({
        type: 'SUBSCRIPTION_PAST_DUE',
        eventId: `SUBSCRIPTION_PAST_DUE:${apt}:${since}`,
        payload: { pastDueSince: since, suspendOn: addDays(since, sub.graceDays), overdueTotalKurus: overdue.reduce((s, i) => s + i.totalKurus, 0), invoiceCount: overdue.length },
      });
    }
    if (sub.status === 'past_due') {
      if (!firstOverdue) {
        move('active', 'paid');
        delete sub.pastDueSince;
      } else if (sub.pastDueSince && day >= addDays(sub.pastDueSince, sub.graceDays)) {
        move('suspended', 'grace_expired');
        sub.suspendedAt = day;
        sub.suspendedReason = 'non_payment';
        events.push({ type: 'SUBSCRIPTION_SUSPENDED', eventId: `SUBSCRIPTION_SUSPENDED:${apt}:${day}`, payload: { suspendedAt: day, reason: 'non_payment' } });
      }
    }
    if (sub.status === 'suspended' && sub.suspendedReason === 'non_payment' && !firstOverdue) {
      events.push({ type: 'SUBSCRIPTION_REACTIVATED', eventId: `SUBSCRIPTION_REACTIVATED:${apt}:${sub.suspendedAt ?? day}`, payload: { reactivatedOn: day, from: 'suspended' } });
      move('active', 'paid');
      delete sub.pastDueSince;
      delete sub.suspendedAt;
      delete sub.suspendedReason;
      // Askida gecen donemler faturalanmaz: donem bittiyse yeni donem bugunden.
      markResume(day);
      renew(day);
    }
  };

  const result = (forceChanged = false): AdvanceResult => {
    Object.assign(sub, subscriptionGsi(sub.status, sub.apartmentId));
    const changed = forceChanged || invoices.length > 0 || JSON.stringify(sub) !== JSON.stringify(input.sub);
    return { sub, invoices, events, transitions, changed };
  };

  return { sub, events, transitions, move, startPeriod, settle, settlePayments, markResume, result };
}

/** Bir gunluk ilerleme (yakalama dahil: kacirilmis gunler tek calismada islenir). */
export function advance(input: AdvanceInput): AdvanceResult {
  const b = builder(input);
  b.settle(input.day);
  return b.result();
}

/**
 * Otomasyon kapaliyken odeme / iptal sonrasi durum: yalnizca odemeyle dogrudan cozulen gecis
 * (yenileme, fatura, gecikme ve bildirim yok).
 */
export function settleAfterPayment(input: AdvanceInput): AdvanceResult {
  const b = builder(input);
  b.settlePayments(input.day);
  return b.result();
}

// ---------------------------------------------------------------------------
// Platform islemleri (SAF)
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_ACTIONS = ['extend_trial', 'activate', 'suspend', 'cancel', 'reactivate'] as const;
export type SubscriptionAction = (typeof SUBSCRIPTION_ACTIONS)[number];

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

export const ACTION_ALLOWED_FROM: Record<SubscriptionAction, readonly SubscriptionStatus[]> = {
  extend_trial: ['trial'],
  activate: ['trial'],
  suspend: ['trial', 'active', 'past_due'],
  cancel: ['trial', 'active', 'past_due', 'suspended'],
  reactivate: ['suspended', 'cancelled'],
};

const STATUS_TEXT: Record<SubscriptionStatus, string> = {
  trial: 'deneme',
  active: 'aktif',
  past_due: 'ödemesi gecikmiş',
  suspended: 'askıya alınmış',
  cancelled: 'iptal edilmiş',
};

/**
 * Platformun elle gecisi; ardindan ayni gun icin gunluk adimlar calisir (donem / vade durumu hemen
 * oturur). `trialEndsAt` yalnizca `extend_trial` icin.
 */
export function applyAction(input: AdvanceInput & { action: SubscriptionAction; trialEndsAt?: IsoDate; automation?: boolean }): AdvanceResult {
  const { action, day } = input;
  if (!ACTION_ALLOWED_FROM[action].includes(input.sub.status)) {
    throw new TransitionError(`Bu işlem ${STATUS_TEXT[input.sub.status]} abonelikte yapılamaz`);
  }
  const b = builder(input);
  const sub = b.sub;
  switch (action) {
    case 'extend_trial':
      if (!input.trialEndsAt || input.trialEndsAt < day) throw new TransitionError('Yeni deneme bitişi bugün veya sonrası olmalıdır');
      sub.trialEndsAt = input.trialEndsAt;
      delete sub.notices;
      break;
    case 'activate':
      // Deneme erken biter; ilk donem bugun baslar.
      b.move('active', 'manual_activate');
      sub.trialEndsAt = addDays(day, -1) < (sub.trialEndsAt ?? day) ? addDays(day, -1) : sub.trialEndsAt;
      b.startPeriod(day);
      break;
    case 'suspend':
      b.move('suspended', 'manual_suspend');
      sub.suspendedAt = day;
      sub.suspendedReason = 'manual';
      b.events.push({ type: 'SUBSCRIPTION_SUSPENDED', eventId: `SUBSCRIPTION_SUSPENDED:${sub.apartmentId}:${day}`, payload: { suspendedAt: day, reason: 'manual' } });
      break;
    case 'cancel':
      b.move('cancelled', 'manual_cancel');
      sub.cancelledAt = day;
      b.events.push({ type: 'SUBSCRIPTION_CANCELLED', eventId: `SUBSCRIPTION_CANCELLED:${sub.apartmentId}:${day}`, payload: { cancelledAt: day } });
      break;
    case 'reactivate': {
      const from = sub.status;
      b.events.push({
        type: 'SUBSCRIPTION_REACTIVATED',
        eventId: `SUBSCRIPTION_REACTIVATED:${sub.apartmentId}:${sub.suspendedAt ?? sub.cancelledAt ?? day}`,
        payload: { reactivatedOn: day, from },
      });
      delete sub.suspendedAt;
      delete sub.suspendedReason;
      // Odenmemis vadesi gecmis fatura kaldiysa ayni gun yeniden `past_due` olur; ek sure bugunden baslar.
      delete sub.pastDueSince;
      if (from === 'cancelled') {
        delete sub.cancelledAt;
        // Iptalden donuste yeni donem tabani bugun.
        delete sub.billingAnchor;
        delete sub.periodIndex;
        b.move('active', 'manual_reactivate');
        b.startPeriod(day);
      } else if (!sub.billingAnchor) {
        // Hic faturalanmamis (denemedeyken askiya alinmis): deneme suruyorsa denemeye doner, bittiyse
        // ilk donem bugun baslar (ucretsiz kalici aktiflik yok).
        if (sub.trialEndsAt && sub.trialEndsAt >= day) b.move('trial', 'manual_reactivate');
        else {
          b.move('active', 'manual_reactivate');
          b.startPeriod(day);
        }
      } else {
        b.move('active', 'manual_reactivate');
        // Askida biten donemler faturalanmaz: bir sonraki yenilemede taban donus gunu olur.
        b.markResume(day);
      }
      break;
    }
  }
  // Otomasyon kapaliyken yalnizca islemin kendisi (yenileme / vade / bildirim adimlari yok).
  if (input.automation !== false && action !== 'cancel' && action !== 'suspend') b.settle(day);
  return b.result(true);
}
