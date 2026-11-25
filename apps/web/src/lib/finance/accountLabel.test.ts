import { describe, expect, it } from 'vitest';
import { formatTRY } from '@/lib/money';
import { balanceSummary, formatLedgerAccountLabel, looksLikeId, sanitizeLedgerText } from './accountLabel';

const U1 = '17e1ba48-0c1d-4c3a-9a51-2f8d3b0e7a11';
const U2 = '2b9f5c10-77aa-4e0f-8d6c-0a1b2c3d4e5f';
const P1 = '501c397c-a041-7026-c6f1-9df74ece66d0';
const ctx = {
  unitLabel: (id: string) => ({ [U1]: 'A · 1', [U2]: 'A · 2' })[id],
  personName: (id: string) => ({ [P1]: 'Malik Kiracı' })[id],
};
const noUuid = (s: string) => expect(s).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);

describe('formatLedgerAccountLabel', () => {
  it('ana cari: blok · daire + taraf (eski UUID adini kullanmaz)', () => {
    const label = formatLedgerAccountLabel({ accountId: `recv-${U1}-owner`, name: `Daire ${U1} - Kat Maliki`, unitId: U1, liableParty: 'owner' }, ctx);
    expect(label).toBe('A · 1 Kat Maliki');
    expect(formatLedgerAccountLabel({ accountId: 'x', name: `Daire ${U1} - Kiraci/Sakin`, unitId: U1, liableParty: 'occupant' }, ctx)).toBe('A · 1 Kiracı / Sakin');
  });

  it('paydas carisi: kisi adi + (paydaş); ad yoksa Kat Maliki', () => {
    const acc = { accountId: 'y', name: `Daire ${U2} - Kat Maliki (paydaş)`, unitId: U2, liableParty: 'owner' as const, coOwner: { userId: P1 } };
    expect(formatLedgerAccountLabel(acc, ctx)).toBe('A · 2 Malik Kiracı (paydaş)');
    expect(formatLedgerAccountLabel({ ...acc, coOwner: { userId: 'bilinmeyen' } }, ctx)).toBe('A · 2 Kat Maliki (paydaş)');
  });

  it('ayrilan cari: tarih korunur', () => {
    expect(formatLedgerAccountLabel({ accountId: 'z', name: 'Daire 3 - Ayrılan sakin (31.10.2026)', unitId: U1, liableParty: 'occupant' }, ctx)).toBe(
      'A · 1 Ayrılan sakin (31.10.2026)',
    );
  });

  it('cozulemeyen daire ve hesapsiz durumda kimlik gostermez', () => {
    const label = formatLedgerAccountLabel({ accountId: 'q', name: 'x', unitId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', liableParty: 'owner' }, ctx);
    expect(label).toBe('Daire Kat Maliki');
    noUuid(label);
    expect(formatLedgerAccountLabel(undefined, ctx)).toBe('Cari');
  });
});

describe('sanitizeLedgerText', () => {
  it('mahsup aciklamasindaki daire kimliklerini cozer', () => {
    const out = sanitizeLedgerText(`Avans mahsubu: Daire ${U1} - Kat Maliki → Daire ${U2} - Kat Maliki (paydaş)`, ctx);
    expect(out).toBe('Avans mahsubu: A · 1 Kat Maliki → A · 2 Kat Maliki (paydaş)');
  });
  it('ters kayit ve bilinmeyen kimlikler', () => {
    const out = sanitizeLedgerText(`Ters kayit: Avans mahsubu: Daire ${U1} - Kiraci/Sakin → ${P1} / deadbeef-dead-4bee-8eef-deadbeefdead`, ctx);
    expect(out).toBe('Ters kayit: Avans mahsubu: A · 1 Kiracı / Sakin → Malik Kiracı / …');
    noUuid(out);
  });
  it('kimlik icermeyen metni degistirmez', () => {
    expect(sanitizeLedgerText('Kasım 2026 aidatı', ctx)).toBe('Kasım 2026 aidatı');
  });
});

describe('yardimcilar', () => {
  it('looksLikeId / balanceSummary', () => {
    expect(looksLikeId(U1)).toBe(true);
    expect(looksLikeId('A · 1')).toBe(false);
    expect(balanceSummary(-121000, formatTRY)).toBe(`avans ${formatTRY(121000)}`);
    expect(balanceSummary(200000, formatTRY)).toBe(`borç ${formatTRY(200000)}`);
    expect(balanceSummary(0, formatTRY)).toBe('bakiye yok');
  });
});
