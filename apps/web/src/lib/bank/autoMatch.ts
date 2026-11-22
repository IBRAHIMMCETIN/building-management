import type { AutoMatchResult, BankStatement, Reconciliation } from '@/lib/api/bank';
import { formatTRY } from '@/lib/money';

/*
 * Faz B3 - Toplu otomatik onay ve ayrintili mutabakat (saf yardimcilar).
 */

/** Varsayilan guven esigi (API ile ayni: AUTO_MATCH_DEFAULT_MIN_CONFIDENCE). */
export const DEFAULT_MIN_CONFIDENCE = 0.85;
/** Secilebilir esikler (API alt siniri 0.6). */
export const MIN_CONFIDENCE_OPTIONS = [0.95, 0.9, 0.85, 0.75, 0.6] as const;

/**
 * API istek basina sinirli sayida satir isler (`remaining`). Ayni idempotency anahtariyla,
 * calisma tamamlanana kadar tekrar cagirir. Bir cagri hicbir satir eslestiremiyorsa (ornegin
 * kalanlarin hepsi es zamanli degismis) sonsuz donguye girmeden durur.
 */
export async function runAutoMatch(
  call: () => Promise<AutoMatchResult>,
  opts: { maxCalls?: number; onProgress?: (r: AutoMatchResult) => void } = {},
): Promise<AutoMatchResult> {
  const maxCalls = opts.maxCalls ?? 40;
  let last = await call();
  opts.onProgress?.(last);
  for (let i = 1; i < maxCalls && !last.completed && last.remaining > 0 && last.thisCall.matchedCount > 0; i++) {
    last = await call();
    opts.onProgress?.(last);
  }
  return last;
}

/** Sonuc bildirimi (tek cumle + atlananlar). */
/** `tone`: Alert tonu (success | info). */
export function autoMatchMessage(r: AutoMatchResult): { tone: 'success' | 'info'; text: string } {
  const parts: string[] = [];
  if (r.skippedLowConfidence) parts.push(`${r.skippedLowConfidence} düşük güvenli`);
  if (r.skippedAmbiguous) parts.push(`${r.skippedAmbiguous} belirsiz (birden fazla aday)`);
  if (r.skippedClosed) parts.push(`${r.skippedClosed} kapalı cariye düşen`);
  if (r.skippedConflict) parts.push(`${r.skippedConflict} başka işlemle değişen`);
  const head =
    r.matchedCount > 0 ? `${r.matchedCount} satır onaylandı (${formatTRY(r.totalMatchedAmount)}).` : 'Onaylanacak yüksek güvenli satır bulunamadı.';
  const tail = parts.length ? ` Atlanan: ${parts.join(', ')}.` : '';
  const pending = !r.completed && r.remaining > 0 ? ` ${r.remaining} satır işlenemedi; yeniden deneyin.` : '';
  return { tone: r.matchedCount > 0 && !pending ? 'success' : 'info', text: `${head}${tail}${pending}` };
}

/** Toplu onay icin varsayilan ekstre: en son biten aktarilmis ekstre. */
export function latestCommittedStatement(statements: readonly BankStatement[]): BankStatement | undefined {
  return statements
    .filter((s) => s.status === 'committed' && s.period)
    .sort((a, b) => (b.period?.to ?? '').localeCompare(a.period?.to ?? ''))[0];
}

export type ReconRow = { key: string; label: string; count: number; amount: number; tone: 'success' | 'warning' | 'neutral' };

/** Mutabakat dokumu satirlari (eski API yanitinda `breakdown` yoksa B2 ozetinden). */
export function reconciliationRows(r: Pick<Reconciliation, 'lines' | 'breakdown'>): ReconRow[] {
  const b = r.breakdown;
  if (!b) {
    return [
      { key: 'matched', label: 'Eşleşen', ...r.lines.matched, tone: 'success' },
      { key: 'unmatchedIn', label: 'Bekleyen giren', ...r.lines.unmatchedIn, tone: 'warning' },
      { key: 'unmatchedOut', label: 'Bekleyen çıkan', ...r.lines.unmatchedOut, tone: 'warning' },
      { key: 'ignored', label: 'Yoksayılan', ...r.lines.ignored, tone: 'neutral' },
    ];
  }
  return [
    { key: 'matchedIn', label: 'Eşleşen giren (tahsilat)', ...b.matchedIn, tone: 'success' },
    { key: 'matchedOut', label: 'Eşleşen çıkan (gider / tedarikçi)', ...b.matchedOut, tone: 'success' },
    { key: 'unmatchedIn', label: 'Bekleyen giren', ...b.unmatchedIn, tone: 'warning' },
    { key: 'unmatchedOut', label: 'Bekleyen çıkan', ...b.unmatchedOut, tone: 'warning' },
    { key: 'ignoredIn', label: 'Yoksayılan giren', ...b.ignoredIn, tone: 'neutral' },
    { key: 'ignoredOut', label: 'Yoksayılan çıkan', ...b.ignoredOut, tone: 'neutral' },
  ];
}

/**
 * Fark yorumu: bekleyen satirlarla tam aciklaniyorsa bilgi, aciklanamayan fark varsa uyari.
 * `unexplainedDiff` yoksa (kapanis bakiyesi olmayan ekstre) yorum yapilmaz.
 */
export function differenceNote(r: Pick<Reconciliation, 'difference' | 'pendingNet' | 'unexplainedDiff'>): { tone: 'success' | 'info' | 'danger'; text: string } | null {
  if (r.difference === undefined) return null;
  if (r.difference === 0) return { tone: 'success', text: 'Banka ve defter bakiyesi eşit.' };
  if (r.unexplainedDiff === undefined) return null;
  if (r.unexplainedDiff === 0) return { tone: 'info', text: 'Fark, henüz eşleştirilmemiş banka satırlarından kaynaklanıyor.' };
  return {
    tone: 'danger',
    text: `Bekleyen satırlarla açıklanamayan fark: ${formatTRY(Math.abs(r.unexplainedDiff))}. Yoksayılan ama deftere işlenmemiş hareketleri veya bankaya yansımamış elle kayıtları kontrol edin.`,
  };
}
