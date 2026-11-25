import { describe, expect, it } from 'vitest';
import { compactTRY, niceStep } from './DashboardPage';

describe('Genel Bakis grafik yardimcilari', () => {
  it('eksen adimi 1-2-5 dizisinden', () => {
    expect(niceStep(130_000)).toBe(200_000);
    expect(niceStep(450_000)).toBe(500_000);
    expect(niceStep(1_000_000)).toBe(1_000_000);
    expect(niceStep(0)).toBe(100);
  });

  it('kisa TL etiketi', () => {
    expect(compactTRY(0)).toBe('0');
    expect(compactTRY(1_250_000)).toBe('12,5 B');
    expect(compactTRY(150_000_000)).toBe('1,5 Mn');
  });
});
