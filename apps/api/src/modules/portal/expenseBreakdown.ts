/**
 * Adim 3 - sakin ana sayfasi: aylik gider dagilimi (halka grafik).
 *
 * Kaynak: P1-c hesap-ay ozeti (`MSUM#<YYYY-MM>#<hesap>`) - her defter yazimi ozeti AYNI atomik
 * yazimda gunceller; burada yalnizca tek ayin ozet kayitlari okunur (tam defter taramasi yok).
 * Site ozeti henuz hazir degilse (`MSUMSTATE.ready` yok) yalnizca o ayin islemleri (`TX#<ay>`
 * araligi) okunur; iki yol kurus kurus aynidir (`monthDeltas`). Yeni veri yazilmaz.
 *
 * Kurallar:
 *  - Gider = gider hesabinin o ayki net hareketi (borc - alacak; ters kayitlar duser). Net <= 0
 *    olan kategori gosterilmez.
 *  - Kategoriler sade ve sabittir (hesap adi / tedarikci / kisi adi ASLA donmez): Elektrik, Su,
 *    Isinma, Temizlik, Asansor ve Bakim, Guvenlik, Bahce ve Peyzaj, Diger.
 *  - Personel / kapici gideri (gizlilik) ve yonetim, diger, ozel acilmis gider hesaplari "Diger"de.
 *  - Yuzdeler 10.000 taban puan (yuzde iki ondalik) uzerinden en buyuk kalan yontemiyle dagitilir:
 *    toplam daima tam %100,00; tutarlar kurus olarak birebir (yuvarlama yok).
 */
import type { IsoDate } from '../core/types.js';
import { ValidationError } from '../core/validation.js';
import { type MonthSummaryItem, monthDeltas, monthTotals } from '../finance/monthSummary.js';
import type { Account, Transaction } from '../finance/types.js';

export const EXPENSE_CATEGORIES = ['electricity', 'water', 'heating', 'cleaning', 'maintenance', 'security', 'garden', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** Sakine gosterilen sade adlar ve ikon anahtarlari (web/mobil ikon eslemesi). */
export const EXPENSE_CATEGORY_META: Readonly<Record<ExpenseCategory, { label: string; icon: string }>> = {
  electricity: { label: 'Elektrik', icon: 'zap' },
  water: { label: 'Su', icon: 'droplets' },
  heating: { label: 'Isınma', icon: 'flame' },
  cleaning: { label: 'Temizlik', icon: 'sparkles' },
  maintenance: { label: 'Asansör ve Bakım', icon: 'wrench' },
  security: { label: 'Güvenlik', icon: 'shield' },
  garden: { label: 'Bahçe ve Peyzaj', icon: 'trees' },
  other: { label: 'Diğer', icon: 'ellipsis' },
};

/**
 * Varsayilan gider hesaplari (finance/service.ts `DEFAULT_EXPENSE_ACCOUNTS`) -> kategori.
 * Listede olmayan her gider hesabi (personel dahil) "Diger"dir: ozel hesap adlari tedarikci veya
 * kisi adi icerebilir, sakine gosterilmez.
 */
export const ACCOUNT_CATEGORY: Readonly<Record<string, ExpenseCategory>> = {
  'exp-electricity': 'electricity',
  'exp-water': 'water',
  'exp-heating': 'heating',
  'exp-cleaning': 'cleaning',
  'exp-elevator': 'maintenance',
  'exp-repair': 'maintenance',
  'exp-security': 'security',
  'exp-garden': 'garden',
  // Gizlilik: personel maasi ayri kalem olarak gosterilmez.
  'exp-staff': 'other',
  'exp-management': 'other',
  'exp-other': 'other',
};

export const categoryOf = (accountId: string): ExpenseCategory => ACCOUNT_CATEGORY[accountId] ?? 'other';

export type ExpenseBreakdownItem = {
  category: ExpenseCategory;
  label: string;
  icon: string;
  /** Kurus. */
  amount: number;
  /** Taban puan (10.000 = %100); kalemlerin toplami tam 10.000. */
  shareBp: number;
  /** Yuzde, iki ondalik (shareBp / 100). */
  percent: number;
};

export type ExpenseBreakdown = {
  month: string;
  currency: 'TRY';
  /** Kurus; kalem tutarlarinin toplami. */
  total: number;
  items: ExpenseBreakdownItem[];
  /** Ozet kaynagi (tani): `summary` hesap-ay ozeti, `period` o ayin islemleri. */
  source: 'summary' | 'period';
  /** Gider yoksa true (arayuz bos durum gosterir). */
  empty: boolean;
};

/**
 * En buyuk kalan yontemi: `total` paylari agirliklara oranla tam sayi olarak dagitir, toplam tam
 * `total`. Esitlikte buyuk agirlik, sonra liste sirasi onde (deterministik).
 */
export function largestRemainder(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w, i) => {
    const exact = BigInt(w) * BigInt(total);
    const floor = exact / BigInt(sum);
    return { i, w, floor: Number(floor), rem: exact - floor * BigInt(sum) };
  });
  let left = total - raw.reduce((s, r) => s + r.floor, 0);
  const order = [...raw].sort((a, b) => (a.rem === b.rem ? b.w - a.w || a.i - b.i : a.rem > b.rem ? -1 : 1));
  const out = raw.map((r) => r.floor);
  for (const r of order) {
    if (left <= 0) break;
    out[r.i] = (out[r.i] as number) + 1;
    left--;
  }
  return out;
}

/** Hesap -> net ayki gider (kurus) haritasindan sakin dagilimi. */
export function buildExpenseBreakdown(month: string, netByAccount: ReadonlyMap<string, number>, source: ExpenseBreakdown['source']): ExpenseBreakdown {
  const byCategory = new Map<ExpenseCategory, number>();
  for (const [accountId, net] of netByAccount) {
    const c = categoryOf(accountId);
    byCategory.set(c, (byCategory.get(c) ?? 0) + net);
  }
  // Sabit sira; net <= 0 (yalniz ters kayit vb.) kategori gosterilmez.
  const kept = EXPENSE_CATEGORIES.filter((c) => (byCategory.get(c) ?? 0) > 0).map((c) => ({ category: c, amount: byCategory.get(c) as number }));
  // Buyukten kucuge; "Diger" her zaman en sonda.
  kept.sort((a, b) => (a.category === 'other' ? 1 : b.category === 'other' ? -1 : b.amount - a.amount || EXPENSE_CATEGORIES.indexOf(a.category) - EXPENSE_CATEGORIES.indexOf(b.category)));
  const total = kept.reduce((s, k) => s + k.amount, 0);
  const shares = largestRemainder(
    kept.map((k) => k.amount),
    10_000,
  );
  const items = kept.map((k, i) => ({
    category: k.category,
    ...EXPENSE_CATEGORY_META[k.category],
    amount: k.amount,
    shareBp: shares[i] as number,
    percent: (shares[i] as number) / 100,
  }));
  return { month, currency: 'TRY', total, items, source, empty: items.length === 0 };
}

/** Ozet kayitlarindan gider hesaplarinin net ayki hareketi. */
export function netFromSummaries(items: readonly MonthSummaryItem[], expenseIds: ReadonlySet<string>, month: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    if (item.month !== month || !expenseIds.has(item.accountId)) continue;
    const t = monthTotals(item);
    out.set(item.accountId, (out.get(item.accountId) ?? 0) + t.d - t.c);
  }
  return out;
}

/** Ayin islemlerinden (ayni kural, `monthDeltas`) gider hesaplarinin net hareketi. */
export function netFromTransactions(transactions: readonly Transaction[], expenseIds: ReadonlySet<string>, month: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of monthDeltas(transactions).values()) {
    if (v.month !== month || !expenseIds.has(v.accountId)) continue;
    out.set(v.accountId, (out.get(v.accountId) ?? 0) + v.d - v.c);
  }
  return out;
}

export type ExpenseBreakdownDeps = {
  listAccounts(apartmentId: string): Promise<Pick<Account, 'accountId' | 'type' | 'siteId'>[]>;
  listMonthSummaries?(apartmentId: string, fromMonth: string, toMonth?: string): Promise<MonthSummaryItem[]>;
  getMonthSummaryState?(apartmentId: string): Promise<{ ready?: boolean } | undefined>;
  listTransactions(apartmentId: string, query?: { from?: string; to?: string; consistent?: boolean }): Promise<{ items: Transaction[] }>;
  now?: () => Date;
};

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const MAX_MONTHS_BACK = 24;

const istanbulMonth = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit' }).format(d).slice(0, 7);

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * `month` verilmezse bu ay (Istanbul). Gelecek ay ve 24 aydan eski ay reddedilir.
 */
export function resolveMonth(month: string | undefined, now: Date): string {
  const current = istanbulMonth(now);
  if (month === undefined || month === '') return current;
  if (!MONTH.test(month)) throw new ValidationError('month YYYY-AA olmalidir', 'month');
  if (month > current) throw new ValidationError('Gelecek ay icin gider dagilimi yok', 'month');
  if (month < addMonths(current, -MAX_MONTHS_BACK)) throw new ValidationError(`En fazla ${MAX_MONTHS_BACK} ay oncesi gosterilebilir`, 'month');
  return month;
}

const lastDay = (month: string): IsoDate => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

export async function loadExpenseBreakdown(deps: ExpenseBreakdownDeps, apartmentId: string, monthInput?: string): Promise<ExpenseBreakdown> {
  const month = resolveMonth(monthInput, (deps.now ?? (() => new Date()))());
  const accounts = await deps.listAccounts(apartmentId);
  const expenseIds = new Set(accounts.filter((a) => a.type === 'expense' && a.siteId === apartmentId).map((a) => a.accountId));
  if (expenseIds.size === 0) return buildExpenseBreakdown(month, new Map(), 'summary');
  const ready = Boolean(deps.listMonthSummaries && deps.getMonthSummaryState && (await deps.getMonthSummaryState(apartmentId))?.ready);
  if (ready) {
    const items = await (deps.listMonthSummaries as NonNullable<ExpenseBreakdownDeps['listMonthSummaries']>)(apartmentId, month, month);
    return buildExpenseBreakdown(month, netFromSummaries(items, expenseIds, month), 'summary');
  }
  const { items } = await deps.listTransactions(apartmentId, { from: `${month}-01`, to: lastDay(month), consistent: true });
  return buildExpenseBreakdown(month, netFromTransactions(items.filter((t) => t.siteId === apartmentId), expenseIds, month), 'period');
}
