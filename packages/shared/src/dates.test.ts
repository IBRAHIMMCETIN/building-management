import { describe, expect, it } from 'vitest';
import { formatDate } from './dates';

describe('formatDate', () => {
  it('formats a plain date without time zone shift', () => {
    expect(formatDate('2026-11-08')).toBe(new Date(Date.UTC(2026, 10, 8)).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }));
  });

  it('formats a full timestamp as the Istanbul calendar day instead of "Invalid Date"', () => {
    // 21:30 UTC = 00:30 the next day in Istanbul (UTC+03:00)
    const late = formatDate('2026-11-10T21:30:00.000Z');
    expect(late).not.toContain('Invalid');
    expect(late).toBe(formatDate('2026-11-11'));
    expect(formatDate('2026-11-10T06:00:00.000Z')).toBe(formatDate('2026-11-10'));
  });
});
