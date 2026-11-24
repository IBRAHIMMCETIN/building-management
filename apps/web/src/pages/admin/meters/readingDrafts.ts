import type { ReadingItemInput, SheetRow } from '@/lib/api/meters';
import { parseIndexText } from '@/lib/meters/model';

/** Tahmini okuma onerisi olan eksik satirlar (karar 1: yonetici acikca kabul eder). */
export const estimableRows = (rows: readonly SheetRow[]) => rows.filter((r) => r.inScope && r.status === 'missing' && !!r.suggestion);

/** Kaydedilecek ogeler: degisen taslaklar; gecersiz metin istemcide yakalanir. */
export function draftItems(rows: readonly SheetRow[], drafts: Record<string, string>) {
  const items: ReadingItemInput[] = [];
  const invalid: Record<string, string> = {};
  for (const r of rows) {
    const text = drafts[r.meterId];
    if (text === undefined || text.trim() === '') continue;
    const p = parseIndexText(text, r.scale);
    if (!p.ok) invalid[r.meterId] = p.message;
    else if (p.value !== r.endIndex || r.reading?.estimated) items.push({ meterId: r.meterId, endIndex: p.value });
  }
  return { items, invalid };
}

