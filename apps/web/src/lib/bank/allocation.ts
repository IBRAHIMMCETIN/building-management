import type { MatchTarget, StatementPreview, Suggestion } from '@/lib/api/bank';
import { kurusToInput, parseTRYToKurus } from '@/lib/money';

/*
 * Banka eslestirme ekranlarinin saf yardimcilari (bilesenlerden ayri test edilir).
 */

/** API ile ayni sinir (bank/types.ts MAX_ALLOCATIONS). */
export const MAX_ALLOCATIONS = 10;

export type AllocationRow = { accountId: string; amount: string };

export type AllocationState = {
  /** Gecerli satirlarin toplami (kurus). */
  total: number;
  /** Satir tutari - toplam (pozitif: dagitilmamis, negatif: fazla). */
  remaining: number;
  valid: boolean;
  error?: string;
  /** API'ye gonderilecek dagilim (yalnizca gecerliyse). */
  allocations: { accountId: string; amount: number }[];
};

/** Formdaki dagilim satirlarini dogrular (API kurallariyla ayni: 1-10 alt cari, toplam = tutar). */
export function allocationState(lineAmount: number, rows: readonly AllocationRow[]): AllocationState {
  const parsed = rows.map((r) => ({ accountId: r.accountId, amount: parseTRYToKurus(r.amount) }));
  const total = parsed.reduce((s, r) => s + (r.amount ?? 0), 0);
  const remaining = lineAmount - total;
  const base = { total, remaining, allocations: [] as { accountId: string; amount: number }[] };
  if (rows.length === 0) return { ...base, valid: false, error: 'En az bir cari seçin' };
  if (rows.length > MAX_ALLOCATIONS) return { ...base, valid: false, error: `En fazla ${MAX_ALLOCATIONS} cariye bölünebilir` };
  if (parsed.some((r) => !r.accountId)) return { ...base, valid: false, error: 'Her satır için cari seçin' };
  if (parsed.some((r) => r.amount === null)) return { ...base, valid: false, error: 'Tutarlar geçerli olmalı (örn. 1.500,00)' };
  if (new Set(parsed.map((r) => r.accountId)).size !== parsed.length) return { ...base, valid: false, error: 'Aynı cari iki kez seçilemez' };
  if (remaining !== 0) {
    return { ...base, valid: false, error: remaining > 0 ? 'Dağıtılmamış tutar var' : 'Dağıtım satır tutarını aşıyor' };
  }
  return { ...base, valid: true, allocations: parsed.map((r) => ({ accountId: r.accountId, amount: r.amount as number })) };
}

/** Oneriden form satirlari. */
export function rowsFromSuggestion(s: Suggestion | undefined): AllocationRow[] {
  return (s?.allocations ?? []).map((a) => ({ accountId: a.accountId, amount: kurusToInput(a.amount) }));
}

/** Kalan tutari son satira ekler (bolme kolayligi); satir yoksa tamamini yeni satira yazar. */
export function fillRemaining(lineAmount: number, rows: readonly AllocationRow[]): AllocationRow[] {
  const state = allocationState(lineAmount, rows);
  if (state.remaining <= 0 || rows.length === 0) return [...rows];
  const last = rows[rows.length - 1] as AllocationRow;
  const current = parseTRYToKurus(last.amount) ?? 0;
  return [...rows.slice(0, -1), { ...last, amount: kurusToInput(current + state.remaining) }];
}

export type ConfidenceTone = 'success' | 'accent' | 'warning' | 'neutral';

/** Guven rozeti: >= 0.9 kesine yakin, >= 0.6 guclu, >= 0.4 zayif. */
export function confidenceBadge(confidence: number): { tone: ConfidenceTone; label: string } {
  const pct = `%${Math.round(confidence * 100)}`;
  if (confidence >= 0.999) return { tone: 'success', label: 'Kesin (referans kodu)' };
  if (confidence >= 0.9) return { tone: 'success', label: `Çok güçlü ${pct}` };
  if (confidence >= 0.6) return { tone: 'accent', label: `Güçlü ${pct}` };
  if (confidence >= 0.4) return { tone: 'warning', label: `Zayıf ${pct}` };
  return { tone: 'neutral', label: `Belirsiz ${pct}` };
}

/** "Onayla" tek tikla yalnizca guclu onerilerde gosterilir. */
export const canQuickConfirm = (s: Suggestion | undefined): s is Suggestion => Boolean(s && s.confidence >= 0.6 && s.allocations.length > 0);

const fold = (s: string) =>
  s
    .toLocaleLowerCase('tr-TR')
    .replace(/[çğıöşü]/g, (c) => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' })[c] ?? c)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Cari arama: daire etiketi, kisi adi veya referans kodu (Turkce karakter duyarsiz). */
export function filterTargets(targets: readonly MatchTarget[], query: string, limit = 30): MatchTarget[] {
  const q = fold(query);
  if (!q) return targets.slice(0, limit);
  const terms = q.split(' ');
  return targets
    .filter((t) => {
      const hay = fold([t.unitLabel, t.partyLabel, t.refCode ?? '', ...t.holderNames].join(' '));
      return terms.every((term) => hay.includes(term));
    })
    .slice(0, limit);
}

/** Onizleme: aktarim icin uyari onayi gerekiyor mu (API kurallariyla ayni)? */
export function previewNeedsAck(preview: Pick<StatementPreview, 'warnings'>): boolean {
  return preview.warnings.length > 0;
}

/** Onizleme ozeti: kac satir yeni yazilacak, kaci zaten var/tekrar. */
export function previewCounts(preview: Pick<StatementPreview, 'lines' | 'errors'>) {
  let fresh = 0;
  let existing = 0;
  let duplicate = 0;
  for (const l of preview.lines) {
    if (l.flags.includes('duplicate_in_file')) duplicate++;
    else if (l.flags.includes('duplicate_existing')) existing++;
    else fresh++;
  }
  return { fresh, existing, duplicate, errors: preview.errors.length };
}

/** IBAN'i 4'lu gruplarla gosterir: TR12 3456 ... */
export const groupIban = (iban: string) => iban.replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim();
