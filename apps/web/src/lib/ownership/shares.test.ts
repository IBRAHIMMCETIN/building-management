import { describe, expect, it } from 'vitest';
import { applyDraftMoves, formatBps, formatShare, fullShareDrafts, isCompleteTable, parseShare, sharesToBps, totalShare } from './shares';

const half = { numerator: 1, denominator: 2 };
const third = { numerator: 1, denominator: 3 };
const quarter = { numerator: 1, denominator: 4 };
const row = (userId: string, share: { numerator: number; denominator: number }) => ({ userId, share, bps: 0 });

describe('hisse yardimcilari', () => {
  it('kesir girdisi: sadelestirme, tam sayi, gecersiz degerler', () => {
    expect(parseShare('2/4')).toEqual(half);
    expect(parseShare(' 1 / 3 ')).toEqual(third);
    expect(parseShare('1')).toEqual({ numerator: 1, denominator: 1 });
    expect(parseShare('3/2')).toBeNull();
    expect(parseShare('0/2')).toBeNull();
    expect(parseShare('1,5')).toBeNull();
    expect(parseShare('')).toBeNull();
    expect(formatShare(third)).toBe('1/3');
  });

  it('toplam ve tamlik', () => {
    expect(totalShare([half, third])).toEqual({ numerator: 5, denominator: 6 });
    expect(isCompleteTable([third, third, third])).toBe(true);
    expect(isCompleteTable([half, third])).toBe(false);
    expect(isCompleteTable([])).toBe(false);
  });

  it('bps gosterimi toplam tam 10.000', () => {
    expect(sharesToBps([third, third, third])).toEqual([3334, 3333, 3333]);
    expect(sharesToBps([half, quarter, quarter])).toEqual([5000, 2500, 2500]);
    const sevenths = sharesToBps([{ numerator: 1, denominator: 7 }, { numerator: 6, denominator: 7 }]);
    expect(sevenths.reduce((s, x) => s + x, 0)).toBe(10_000);
    // Eksik tabloda her pay kendi basina yuvarlanir.
    expect(sharesToBps([half, third])).toEqual([5000, 3333]);
    expect(formatBps(3334)).toBe('%33,34');
    expect(formatBps(5000)).toBe('%50');
  });

  it('taslak hareketler: kismi devir sonucu ve hatalar', () => {
    const before = [row('a', half), row('b', half)];
    const ok = applyDraftMoves(before, [{ fromUserId: 'a', toUserId: 'c', share: '1/4' }], 'share_partial');
    expect(ok).toEqual({
      moves: [{ fromUserId: 'a', toUserId: 'c', share: quarter }],
      after: [
        { userId: 'a', share: quarter },
        { userId: 'b', share: half },
        { userId: 'c', share: quarter },
      ],
    });
    expect(applyDraftMoves(before, [{ fromUserId: 'a', toUserId: 'c', share: '3/4' }], 'share_partial')).toEqual({
      error: '1. harekette devredilen pay devredenin payını aşıyor.',
    });
    expect(applyDraftMoves(before, [{ fromUserId: 'a', toUserId: 'a', share: '1/4' }], 'share_partial')).toMatchObject({ error: expect.stringContaining('aynı kişi') });
    expect(applyDraftMoves(before, [{ fromUserId: 'a', toUserId: 'c', share: 'x' }], 'share_partial')).toMatchObject({ error: expect.stringContaining('geçersiz') });
    expect(applyDraftMoves(before, [], 'share_partial')).toMatchObject({ error: expect.any(String) });
  });

  it('tam satis ve miras kurallari', () => {
    const before = [row('a', half), row('b', half)];
    expect(applyDraftMoves(before, [{ fromUserId: 'a', toUserId: 'n', share: '1/2' }], 'sale_full')).toMatchObject({ error: expect.stringContaining('Tam satışta') });
    const sale = applyDraftMoves(before, fullShareDrafts(before, ['a', 'b'], 'n'), 'sale_full');
    expect(sale).toMatchObject({ after: [{ userId: 'n', share: { numerator: 1, denominator: 1 } }] });
    const inh = applyDraftMoves(
      before,
      [
        { fromUserId: 'a', toUserId: 'h1', share: '1/4' },
        { fromUserId: 'a', toUserId: 'h2', share: '1/4' },
      ],
      'inheritance',
    );
    expect(inh).toMatchObject({ after: [{ userId: 'b' }, { userId: 'h1' }, { userId: 'h2' }] });
    expect(applyDraftMoves(before, [{ fromUserId: 'a', toUserId: 'h1', share: '1/4' }], 'inheritance')).toMatchObject({
      error: expect.stringContaining('tamamı'),
    });
  });
});
