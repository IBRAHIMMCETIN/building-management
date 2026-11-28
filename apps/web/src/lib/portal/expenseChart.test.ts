import { describe, expect, it } from 'vitest';
import { recentMonths } from '@/lib/api/portal';
import { currentIstanbulMonth, donutSegments, formatShare, monthLabel } from './expenseChart';

const item = (category: 'heating' | 'water' | 'other', shareBp: number) => ({ category, label: category, icon: 'x', amount: shareBp, shareBp, percent: shareBp / 100 });

describe('gider halka grafigi yardimcilari', () => {
  it('dilimler cevreyi bosluklarla birlikte tam kaplar; tek dilimde bosluk yok', () => {
    const C = 1000;
    const segs = donutSegments([item('heating', 5000), item('water', 3000), item('other', 2000)], C, 2);
    expect(segs.map((s) => s.offset)).toEqual([0, 500, 800]);
    expect(segs.map((s) => s.length)).toEqual([498, 298, 198]);
    expect(segs.map((s) => s.color)).toEqual(['var(--color-series-3)', 'var(--color-series-2)', 'var(--color-series-other)']);
    expect(donutSegments([item('heating', 10000)], C, 2)[0]?.length).toBe(1000);
    expect(donutSegments([], C)).toEqual([]);
    // Cok kucuk dilim de gorunur kalir.
    expect(donutSegments([item('heating', 9999), item('water', 1)], C, 2)[1]?.length).toBe(1);
  });

  it('yuzde ve ay etiketleri Turkce', () => {
    expect(formatShare(5000)).toBe('%50');
    expect(formatShare(3333)).toBe('%33,3');
    expect(monthLabel('2026-11')).toMatch(/Kasım 2026/);
    expect(currentIstanbulMonth(new Date('2026-11-30T22:30:00Z'))).toBe('2026-12');
    expect(recentMonths('2026-02', 3)).toEqual(['2026-02', '2026-01', '2025-12']);
  });
});
