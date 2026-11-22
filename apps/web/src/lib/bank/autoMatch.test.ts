import { describe, expect, it, vi } from 'vitest';
import type { AutoMatchResult, BankStatement } from '@/lib/api/bank';
import { autoMatchMessage, differenceNote, latestCommittedStatement, reconciliationRows, runAutoMatch } from './autoMatch';

const result = (over: Partial<AutoMatchResult> = {}): AutoMatchResult => ({
  replayed: false,
  statementId: 's1',
  minConfidence: 0.85,
  matchedCount: 0,
  totalMatchedAmount: 0,
  skippedLowConfidence: 0,
  skippedAmbiguous: 0,
  skippedClosed: 0,
  skippedConflict: 0,
  remaining: 0,
  completed: true,
  thisCall: { matchedCount: 0, totalMatchedAmount: 0 },
  ...over,
});

describe('toplu onay dongusu', () => {
  it('kalan satir oldukca ayni cagriyi tekrarlar; tamamlaninca durur', async () => {
    const call = vi
      .fn<() => Promise<AutoMatchResult>>()
      .mockResolvedValueOnce(result({ matchedCount: 25, remaining: 5, completed: false, thisCall: { matchedCount: 25, totalMatchedAmount: 100 } }))
      .mockResolvedValueOnce(result({ matchedCount: 30, remaining: 0, completed: true, thisCall: { matchedCount: 5, totalMatchedAmount: 20 } }));
    const progress = vi.fn();
    const r = await runAutoMatch(call, { onProgress: progress });
    expect(call).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledTimes(2);
    expect(r.matchedCount).toBe(30);
  });

  it('ilerleme olmayan cagride (hepsi es zamanli degismis) sonsuz donguye girmez; ust sinir', async () => {
    const stuck = vi.fn(async () => result({ matchedCount: 3, remaining: 4, completed: false, thisCall: { matchedCount: 0, totalMatchedAmount: 0 } }));
    await runAutoMatch(stuck);
    expect(stuck).toHaveBeenCalledTimes(1);
    const busy = vi.fn(async () => result({ remaining: 1, completed: false, thisCall: { matchedCount: 1, totalMatchedAmount: 1 } }));
    await runAutoMatch(busy, { maxCalls: 3 });
    expect(busy).toHaveBeenCalledTimes(3);
  });
});

describe('toplu onay bildirimi', () => {
  it('eslesen + atlanan ozetleri', () => {
    const m = autoMatchMessage(result({ matchedCount: 12, totalMatchedAmount: 1_800_000, skippedLowConfidence: 3, skippedClosed: 1 }));
    expect(m.tone).toBe('success');
    expect(m.text).toContain('12 satır onaylandı');
    expect(m.text).toContain('18.000,00');
    expect(m.text).toContain('3 düşük güvenli');
    expect(m.text).toContain('1 kapalı cariye düşen');
  });
  it('hic eslesme yoksa / yarim kaldiysa bilgi tonu', () => {
    expect(autoMatchMessage(result())).toEqual({ tone: 'info', text: 'Onaylanacak yüksek güvenli satır bulunamadı.' });
    const partial = autoMatchMessage(result({ matchedCount: 2, remaining: 3, completed: false }));
    expect(partial.tone).toBe('info');
    expect(partial.text).toContain('3 satır işlenemedi');
  });
});

describe('mutabakat yardimcilari', () => {
  const bucket = (count: number, amount: number) => ({ count, amount });
  it('ayrintili dokum: giren/cikan ayri; eski yanit icin B2 ozeti', () => {
    const rows = reconciliationRows({
      lines: { unmatchedIn: bucket(1, 1), unmatchedOut: bucket(2, 2), matched: bucket(3, 3), ignored: bucket(0, 0) },
      breakdown: {
        matchedIn: bucket(2, 300000),
        matchedOut: bucket(1, 2500),
        unmatchedIn: bucket(1, 1),
        unmatchedOut: bucket(2, 2),
        ignoredIn: bucket(0, 0),
        ignoredOut: bucket(0, 0),
      },
    });
    expect(rows.map((r) => [r.key, r.count])).toEqual([
      ['matchedIn', 2],
      ['matchedOut', 1],
      ['unmatchedIn', 1],
      ['unmatchedOut', 2],
      ['ignoredIn', 0],
      ['ignoredOut', 0],
    ]);
    const legacy = reconciliationRows({ lines: { unmatchedIn: bucket(1, 1), unmatchedOut: bucket(2, 2), matched: bucket(3, 3), ignored: bucket(0, 0) } });
    expect(legacy.map((r) => r.key)).toEqual(['matched', 'unmatchedIn', 'unmatchedOut', 'ignored']);
  });

  it('fark yorumu: esit / bekleyenlerle aciklanan / aciklanamayan', () => {
    expect(differenceNote({})).toBeNull();
    expect(differenceNote({ difference: 0, pendingNet: 0, unexplainedDiff: 0 })?.tone).toBe('success');
    expect(differenceNote({ difference: 150000, pendingNet: 150000, unexplainedDiff: 0 })?.tone).toBe('info');
    const bad = differenceNote({ difference: -2500, pendingNet: 0, unexplainedDiff: -2500 });
    expect(bad?.tone).toBe('danger');
    expect(bad?.text).toContain('25,00');
  });

  it('varsayilan ekstre: en son biten aktarilmis ekstre', () => {
    const st = (id: string, to: string, status: 'committed' | 'previewed' = 'committed') =>
      ({ statementId: id, status, period: { from: `${to.slice(0, 8)}01`, to } }) as unknown as BankStatement;
    expect(latestCommittedStatement([st('a', '2026-10-31'), st('b', '2026-11-30', 'previewed'), st('c', '2026-11-15')])?.statementId).toBe('c');
    expect(latestCommittedStatement([])).toBeUndefined();
  });
});
