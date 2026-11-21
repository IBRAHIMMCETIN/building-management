/**
 * Platform yoneticisi odeme ekranlari (P5) icin saf yardimcilar: saglayici secimi, POS ayari,
 * aktarim durum gruplari, komisyon faturasi etiketleri ve donem secimi. Kurallar API ile aynidir:
 *   - payments/fees.ts: MAX_POS_RATE_BASIS_POINTS = 1000 (%10), MAX_POS_FIXED_FEE_KURUS = 5000 (50 TL)
 *   - payments/types.ts: PAYOUT_STATUSES, INVOICE_STATUSES
 *   - payments/invoices.ts manualInvoiceProvider: fatura no 3-40 karakter (harf, rakam, / _ -)
 */
import type { AccountPatch, InvoiceStatus, PaymentAccount, PayoutStatus, PlatformApartment, Settlement } from '@/lib/api/payments';
import type { Tone } from './manager';
import { formatBasisPoints, normalizeIban, parsePercentToBasisPoints } from './manager';

export const MAX_POS_RATE_BASIS_POINTS = 1_000;
export const MAX_POS_FIXED_FEE_KURUS = 5_000;

/** Saglayici adlari ekranda. Bilinmeyen ad oldugu gibi gosterilir. */
export function providerLabel(name: string | null | undefined): string {
  if (!name) return '—';
  if (name === 'iyzico') return 'iyzico';
  if (name === 'paytr') return 'PayTR';
  return name;
}

/** Saglayici secimi: '' = ortam varsayilani (API'ye null gider). */
export const DEFAULT_PROVIDER_OPTION = '';
export const toProviderSetting = (value: string): string | null => (value === DEFAULT_PROVIDER_OPTION ? null : value);

// ----- POS komisyon ayari -----

/**
 * POS sabit ucreti girdisi: "0", "0,25", "1.5", "₺0,25" -> kurus. Bos -> undefined (degistirme /
 * varsayilan). Gecersiz ya da [0, 50 TL] disi -> null. Kayan noktaya cevrilmeden metinden okunur.
 */
export function parseFixedFeeToKurus(input: string): number | null | undefined {
  const s = input.replace(/\s|₺|TL/gi, '');
  if (s === '') return undefined;
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const kurus = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return kurus <= MAX_POS_FIXED_FEE_KURUS ? kurus : null;
}

/** 25 -> "0,25" (form alani icin). */
export function kurusToFeeInput(kurus: number): string {
  return `${Math.floor(kurus / 100)},${String(kurus % 100).padStart(2, '0')}`;
}

/** Etkin komisyon ozeti: "pay %0,75 · POS %2,49 + ₺0,25 (varsayılan)". */
export function feeSummary(acc: PaymentAccount): string {
  const fees = acc.effectiveFees;
  const platform = `pay ${formatBasisPoints(acc.platformFeeBasisPoints)}`;
  if (!fees) return platform;
  const custom = acc.posRateBasisPoints !== undefined || acc.posFixedFeeKurus !== undefined;
  const fixed = (fees.posFixedFeeKurus / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${platform} · POS ${formatBasisPoints(fees.posRateBasisPoints)} + ₺${fixed}${custom ? '' : ' (varsayılan)'}`;
}

// ----- Fatura muhatabi -----

export const isValidVkn = (s: string) => /^\d{10}$/.test(s.trim());

/** Satirda gosterilecek eksikler: aktarim alicisi (PayTR), fatura muhatabi (VKN). */
export function accountWarnings(a: Pick<PlatformApartment, 'account' | 'effectiveProvider'>): string[] {
  const acc = a.account;
  if (!acc) return [];
  const out: string[] = [];
  if (acc.payeeOnFile === false && (a.effectiveProvider ?? acc.provider) === 'paytr') out.push('IBAN kayıtlı değil');
  if (!acc.invoiceRecipient) out.push('Fatura VKN eksik');
  return out;
}

// ----- Aktarimlar -----

export type PayoutGroup = 'waiting' | 'done' | 'returned' | 'failed';

/**
 * Ekrandaki dort grup ve API durumlari:
 *   bekliyor: SENT (bankaya gonderildi), RESEND_PENDING / RESEND_SENT (yeniden gonderim suruyor)
 *   tamamlandi: SETTLED, RESENT
 *   geri dondu: RETURNED (yeniden gonderilebilir)
 *   basarisiz: RESEND_FAILED (yeniden gonderilebilir)
 */
export const PAYOUT_GROUPS: Record<PayoutGroup, readonly PayoutStatus[]> = {
  waiting: ['SENT', 'RESEND_PENDING', 'RESEND_SENT'],
  done: ['SETTLED', 'RESENT'],
  returned: ['RETURNED'],
  failed: ['RESEND_FAILED'],
};

export const PAYOUT_GROUP_OPTIONS: readonly { value: PayoutGroup | 'attention'; label: string }[] = [
  { value: 'attention', label: 'İlgilenilmesi gereken' },
  { value: 'waiting', label: 'Bekliyor' },
  { value: 'done', label: 'Tamamlandı' },
  { value: 'returned', label: 'Geri döndü' },
  { value: 'failed', label: 'Başarısız' },
];

export function payoutGroupOf(status: PayoutStatus): PayoutGroup {
  for (const [group, statuses] of Object.entries(PAYOUT_GROUPS) as [PayoutGroup, readonly PayoutStatus[]][]) {
    if (statuses.includes(status)) return group;
  }
  return 'waiting';
}

const PAYOUT_STATUS: Record<PayoutStatus, { label: string; tone: Tone }> = {
  SENT: { label: 'Bankaya gönderildi', tone: 'neutral' },
  SETTLED: { label: 'Tamamlandı', tone: 'success' },
  RETURNED: { label: 'Geri döndü', tone: 'danger' },
  RESEND_PENDING: { label: 'Yeniden gönderilecek', tone: 'warning' },
  RESEND_SENT: { label: 'Yeniden gönderildi', tone: 'accent' },
  RESENT: { label: 'Yeniden gönderim tamamlandı', tone: 'success' },
  RESEND_FAILED: { label: 'Yeniden gönderim başarısız', tone: 'danger' },
};

export const payoutStatusLabel = (s: PayoutStatus) => PAYOUT_STATUS[s].label;
export const payoutStatusTone = (s: PayoutStatus) => PAYOUT_STATUS[s].tone;
/** API yalnizca RETURNED ve RESEND_FAILED aktarimi yeniden gonderir. */
export const canResend = (s: PayoutStatus) => s === 'RETURNED' || s === 'RESEND_FAILED';

/**
 * Secili gruba gore API sorgusu: 'attention' API varsayilani (status verilmez); tek durumlu
 * gruplar dogrudan, cok durumlu gruplar `all` ile cekilip istemcide suzulur.
 */
export function payoutQueryFor(group: PayoutGroup | 'attention'): { status?: PayoutStatus | 'all'; filter?: readonly PayoutStatus[] } {
  if (group === 'attention') return {};
  const statuses = PAYOUT_GROUPS[group];
  if (statuses.length === 1) return { status: statuses[0] };
  return { status: 'all', filter: statuses };
}

// ----- Bekleyen / basarisiz aktarim onaylari (settlement) -----

export function settlementView(s: Pick<Settlement, 'settlementStatus' | 'approvals'>): { label: string; tone: Tone; detail: string } {
  const failed = s.approvals.filter((a) => a.status === 'failed');
  const waiting = s.approvals.filter((a) => a.status !== 'approved' && a.status !== 'failed');
  if (s.settlementStatus === 'failed' || failed.length > 0) {
    const err = failed.find((a) => a.error)?.error;
    return { label: 'Aktarım başarısız', tone: 'danger', detail: err ? `${err.message} (${err.code})` : `${failed.length} kalem gönderilemedi` };
  }
  const next = waiting
    .map((a) => a.releaseAfter)
    .filter((x): x is string => Boolean(x))
    .sort()[0];
  return { label: 'Aktarım bekliyor', tone: 'warning', detail: next ? `Planlanan gönderim: ${next}` : `${waiting.length} kalem bekliyor` };
}

// ----- Komisyon faturalari -----

const INVOICE_STATUS: Record<InvoiceStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Taslak', tone: 'accent' },
  NEEDS_RECIPIENT: { label: 'VKN eksik', tone: 'warning' },
  ISSUED: { label: 'Kesildi', tone: 'success' },
  CANCELLED: { label: 'İptal', tone: 'neutral' },
};
export const invoiceStatusLabel = (s: InvoiceStatus) => INVOICE_STATUS[s].label;
export const invoiceStatusTone = (s: InvoiceStatus) => INVOICE_STATUS[s].tone;

/** API ile ayni kural (manualInvoiceProvider). Gecerliyse undefined. */
export function invoiceNumberError(input: string): string | undefined {
  const n = input.trim();
  if (n.length < 3 || n.length > 40) return 'Fatura numarası 3-40 karakter olmalı.';
  if (!/^[A-Za-z0-9/_-]+$/.test(n)) return 'Yalnızca harf, rakam ve / _ - kullanılabilir.';
  return undefined;
}

/** Donem secici: Istanbul saatine gore bu ay ve onceki (count-1) ay, en yeni once. */
export function recentPeriods(now: Date = new Date(), count = 12): string[] {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit' }).formatToParts(now);
  let year = Number(parts.find((p) => p.type === 'year')?.value);
  let month = Number(parts.find((p) => p.type === 'month')?.value);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`${year}-${String(month).padStart(2, '0')}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return out;
}

/** "2026-11" -> "Kasım 2026". */
export function periodLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  if (!y || !m) return period;
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('tr-TR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** KDV gosterimi: "KDV dahil %20" / "KDV hariç %20". */
export function vatLabel(mode: 'inclusive' | 'exclusive', rateBasisPoints: number): string {
  return `KDV ${mode === 'inclusive' ? 'dahil' : 'hariç'} ${formatBasisPoints(rateBasisPoints)}`;
}

// ----- Hesap ayarlari formu (platform payi, POS, alici, fatura muhatabi) -----

export type AccountForm = {
  platformFee: string;
  /** Bos = ortam varsayilani. */
  posRate: string;
  posFixed: string;
  changePayee: boolean;
  iban: string;
  accountHolderName: string;
  recipientTitle: string;
  recipientTaxNumber: string;
  recipientTaxOffice: string;
};

const pct = (bp: number) => String(bp / 100).replace('.', ',');

export function accountForm(acc: PaymentAccount): AccountForm {
  return {
    platformFee: pct(acc.platformFeeBasisPoints),
    posRate: acc.posRateBasisPoints === undefined ? '' : pct(acc.posRateBasisPoints),
    posFixed: acc.posFixedFeeKurus === undefined ? '' : kurusToFeeInput(acc.posFixedFeeKurus),
    changePayee: false,
    iban: '',
    accountHolderName: '',
    recipientTitle: acc.invoiceRecipient?.title ?? '',
    recipientTaxNumber: acc.invoiceRecipient?.taxNumber ?? '',
    recipientTaxOffice: acc.invoiceRecipient?.taxOffice ?? '',
  };
}

export type AccountFormResult =
  | { ok: true; patch: AccountPatch; changed: boolean }
  | { ok: false; errors: Partial<Record<keyof AccountForm, string>> };

/**
 * Formu PATCH govdesine cevirir; yalnizca degisen alanlar gider (`provider` her zaman: hesap
 * apartmanin o anki tercihinden bagimsiz olarak kendi saglayicisinda guncellenir).
 */
export function buildAccountPatch(acc: PaymentAccount, f: AccountForm, maxPlatformBp: number): AccountFormResult {
  const errors: Partial<Record<keyof AccountForm, string>> = {};
  const patch: AccountPatch = { provider: acc.provider };

  const fee = parsePercentToBasisPoints(f.platformFee, maxPlatformBp);
  if (fee === null) errors.platformFee = `Pay %0 ile ${formatBasisPoints(maxPlatformBp)} arasında olmalı (örn. 0,75).`;
  else if (fee !== acc.platformFeeBasisPoints) patch.platformFeeBasisPoints = fee;

  if (f.posRate.trim() === '') {
    if (acc.posRateBasisPoints !== undefined) patch.posRateBasisPoints = null;
  } else {
    const rate = parsePercentToBasisPoints(f.posRate, MAX_POS_RATE_BASIS_POINTS);
    if (rate === null) errors.posRate = `POS oranı %0 ile ${formatBasisPoints(MAX_POS_RATE_BASIS_POINTS)} arasında olmalı (örn. 2,49).`;
    else if (rate !== acc.posRateBasisPoints) patch.posRateBasisPoints = rate;
  }

  const fixed = parseFixedFeeToKurus(f.posFixed);
  if (fixed === null) errors.posFixed = 'Sabit ücret ₺0 ile ₺50 arasında olmalı (örn. 0,25).';
  else if (fixed === undefined) {
    if (acc.posFixedFeeKurus !== undefined) patch.posFixedFeeKurus = null;
  } else if (fixed !== acc.posFixedFeeKurus) patch.posFixedFeeKurus = fixed;

  if (f.changePayee) {
    const iban = normalizeIban(f.iban);
    const name = f.accountHolderName.trim();
    if (!iban) errors.iban = 'Geçerli bir TR IBAN girin.';
    if (name.length < 2 || name.length > 140) errors.accountHolderName = 'Hesap sahibi adı 2-140 karakter olmalı.';
    if (iban && !errors.accountHolderName) {
      patch.iban = iban;
      patch.accountHolderName = name;
    }
  }

  const title = f.recipientTitle.trim();
  const taxNumber = f.recipientTaxNumber.trim();
  const taxOffice = f.recipientTaxOffice.trim();
  const current = acc.invoiceRecipient;
  if (!title && !taxNumber && !taxOffice) {
    if (current) patch.invoiceRecipient = null;
  } else {
    if (title.length < 2 || title.length > 300) errors.recipientTitle = 'Unvan 2-300 karakter olmalı.';
    if (!isValidVkn(taxNumber)) errors.recipientTaxNumber = 'VKN 10 haneli olmalı.';
    if (taxOffice.length < 2 || taxOffice.length > 100) errors.recipientTaxOffice = 'Vergi dairesi 2-100 karakter olmalı.';
    if (!current || current.title !== title || current.taxNumber !== taxNumber || current.taxOffice !== taxOffice) {
      patch.invoiceRecipient = { title, taxNumber, taxOffice };
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, patch, changed: Object.keys(patch).length > 1 };
}
