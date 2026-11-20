import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { INTENT_STATUSES } from '@/lib/api/payments';
import {
  MAX_PLATFORM_FEE_BASIS_POINTS,
  accountStatusView,
  formatBasisPoints,
  intentStatusLabel,
  intentStatusTone,
  normalizeIban,
  parsePercentToBasisPoints,
} from './manager';

describe('odeme durumu etiketleri', () => {
  it('her durumun etiketi ve tonu var; inceleme uyari tonunda', () => {
    for (const s of INTENT_STATUSES) expect(intentStatusLabel(s)).toBeTruthy();
    expect(intentStatusTone('NEEDS_REVIEW')).toBe('warning');
    expect(intentStatusTone('SUCCEEDED')).toBe('success');
    expect(intentStatusTone('FAILED')).toBe('danger');
  });
});

describe('platform payi', () => {
  it('baz puan <-> yuzde', () => {
    expect(formatBasisPoints(150)).toBe('%1,5');
    expect(formatBasisPoints(0)).toBe('%0');
    expect(formatBasisPoints(2000)).toBe('%20');
    expect(parsePercentToBasisPoints('1,5')).toBe(150);
    expect(parsePercentToBasisPoints('%2')).toBe(200);
    expect(parsePercentToBasisPoints('0.25')).toBe(25);
    expect(parsePercentToBasisPoints('0')).toBe(0);
  });

  it('gecersiz veya ust sinir (API: %20) disi', () => {
    expect(MAX_PLATFORM_FEE_BASIS_POINTS).toBe(2000);
    expect(parsePercentToBasisPoints('20,01')).toBeNull();
    expect(parsePercentToBasisPoints('-1')).toBeNull();
    expect(parsePercentToBasisPoints('1,234')).toBeNull();
    expect(parsePercentToBasisPoints('abc')).toBeNull();
    expect(parsePercentToBasisPoints('')).toBeNull();
  });
});

describe('hesap durumu', () => {
  it('saglayici yoksa kapali; kayit yoksa platform yoneticisine yonlendirir', () => {
    expect(accountStatusView({ configured: false, status: 'not_registered' }).label).toBe('Kapalı');
    expect(accountStatusView({ configured: true, status: 'not_registered' }).body).toMatch(/platform yöneticisi/);
    expect(accountStatusView({ configured: true, status: 'active' }).tone).toBe('success');
    expect(accountStatusView({ configured: true, status: 'disabled' }).tone).toBe('warning');
  });
});

describe('IBAN', () => {
  it('TR IBAN mod-97 kontrolu (API ile ayni kural)', () => {
    expect(normalizeIban('TR33 0006 1005 1978 6457 8413 26')).toBe('TR330006100519786457841326');
    expect(normalizeIban('tr330006100519786457841326')).toBe('TR330006100519786457841326');
    expect(normalizeIban('TR330006100519786457841327')).toBeNull();
    expect(normalizeIban('DE89370400440532013000')).toBeNull();
    expect(normalizeIban('TR33000610051978645784132')).toBeNull();
  });
});
