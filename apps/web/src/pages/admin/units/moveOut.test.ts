import { describe, expect, it } from 'vitest';
import { type CariClosure, type ClosurePreview, closurePreviewSchema, closureSchema } from '@/lib/api/closures';
import {
  advanceTargetLabel,
  blockingReason,
  buildCreateInput,
  canOfferReverse,
  debtTargetLabel,
  decisionErrors,
  defaultDecision,
  outcomeText,
  reasonError,
} from './moveOut';

const preview = (over: Partial<ClosurePreview> = {}): ClosurePreview =>
  closurePreviewSchema.parse({
    unitId: 'u1',
    party: 'occupant',
    moveOutDate: '2026-11-15',
    sourceAccountId: 'recv-u1-occupant',
    lateFeeMonthlyBasisPoints: 500,
    lateFee: 1200,
    net: 161200,
    debt: 161200,
    advance: 0,
    items: [
      { sourceChargeId: 'tx1', category: 'principal', description: 'Ekim aidatı', date: '2026-10-01', dueDate: '2026-10-10', amount: 160000 },
      { sourceChargeId: 'late-fee-at-closure', category: 'late_fee', description: 'Gecikme', date: '2026-11-15', dueDate: '2026-11-15', amount: 1200 },
    ],
    later: { charges: 0, credits: 0, creditAmount: 0 },
    memberships: [
      { userId: 'kiraci-2', relation: 'tenant', residesInUnit: true, startDate: '2025-01-01', change: 'ended' },
      { userId: 'kiraci-1', relation: 'tenant', residesInUnit: true, startDate: '2025-01-01', change: 'ended' },
    ],
    incomingOwners: [],
    targets: { debt: ['former', 'owner'], advance: ['refund', 'former', 'owner'] },
    warnings: [],
    ...over,
  });

const fmt = (k: number) => `${(k / 100).toFixed(2)} TL`;

describe('tasinma sihirbazi: varsayilanlar ve dogrulama', () => {
  it('varsayilan karar: tum ayrilanlar secili, borc ve avans ayrilan carisinde (karar 1)', () => {
    const d = defaultDecision(preview());
    expect(d.userIds).toEqual(['kiraci-2', 'kiraci-1']);
    expect(d.debtTo).toBe('former');
    expect(d.advanceTo).toBe('former');
    expect(d.newOwnerUserId).toBe('');
  });

  it('tek gelen malik varsa yeni malik on secilir', () => {
    const p = preview({ party: 'owner', incomingOwners: [{ userId: 'yeni', startDate: '2026-11-16' }], targets: { debt: ['former', 'new_owner'], advance: ['refund', 'former'] } });
    expect(defaultDecision(p).newOwnerUserId).toBe('yeni');
  });

  it('yeni malike devirde malik secimi, iadede kasa/banka zorunlu; hedef listede olmali', () => {
    const owner = preview({ party: 'owner', targets: { debt: ['former', 'new_owner'], advance: ['refund', 'former'] } });
    expect(decisionErrors(owner, { ...defaultDecision(owner), debtTo: 'new_owner' })).toEqual({ newOwnerUserId: 'Yeni maliki seçin.' });
    expect(decisionErrors(owner, { ...defaultDecision(owner), debtTo: 'owner' }).debtTo).toBeDefined();

    const adv = preview({ net: -50000, debt: 0, advance: 50000, items: [] });
    expect(decisionErrors(adv, { ...defaultDecision(adv), advanceTo: 'refund' })).toEqual({
      refundAccountId: 'İadenin yapılacağı kasa/banka hesabını seçin.',
    });
    expect(decisionErrors(adv, { ...defaultDecision(adv), advanceTo: 'refund', refundAccountId: 'cash-main' })).toEqual({});
    // Borc yokken borc hedefi dogrulanmaz.
    expect(decisionErrors(adv, { ...defaultDecision(adv), debtTo: 'new_owner' })).toEqual({});
  });

  it('gerekce 5-300 karakter', () => {
    expect(reasonError('  abc ')).toBeDefined();
    expect(reasonError('Kiracı taşındı')).toBeUndefined();
    expect(reasonError('x'.repeat(301))).toBeDefined();
  });

  it('cari bu tarihe kadar zaten kapaliysa devam engellenir', () => {
    expect(blockingReason(preview({ closedThrough: '2026-11-15' }))).toBeDefined();
    expect(blockingReason(preview({ closedThrough: '2026-06-30' }))).toBeUndefined();
    expect(blockingReason(preview())).toBeUndefined();
  });
});

describe('buildCreateInput', () => {
  it('ilgisiz secimleri gondermez; kimlikler sirali, gerekce kirpilir', () => {
    const p = preview();
    const body = buildCreateInput(p, { ...defaultDecision(p), debtTo: 'owner', advanceTo: 'refund', refundAccountId: 'cash-main', reason: '  Taşındı  ' }, 'key-12345678');
    expect(body).toEqual({
      idempotencyKey: 'key-12345678',
      party: 'occupant',
      moveOutDate: '2026-11-15',
      userIds: ['kiraci-1', 'kiraci-2'],
      debtTo: 'owner',
      // Avans yok: iade secimi ve hesap gonderilmez.
      advanceTo: 'former',
      reason: 'Taşındı',
    });
  });

  it('yeni malike devir ve avans iadesi alanlari yalnizca ilgiliyse eklenir', () => {
    const owner = preview({ party: 'owner', targets: { debt: ['former', 'new_owner'], advance: ['refund', 'former'] } });
    expect(buildCreateInput(owner, { ...defaultDecision(owner), debtTo: 'new_owner', newOwnerUserId: 'yeni', reason: 'Satış' }, 'k'.repeat(8))).toMatchObject({
      debtTo: 'new_owner',
      newOwnerUserId: 'yeni',
    });
    const adv = preview({ net: -50000, debt: 0, advance: 50000, items: [] });
    const body = buildCreateInput(adv, { ...defaultDecision(adv), debtTo: 'owner', advanceTo: 'refund', refundAccountId: 'bank-1', reason: 'İade' }, 'k'.repeat(8));
    expect(body).toMatchObject({ debtTo: 'former', advanceTo: 'refund', refundAccountId: 'bank-1' });
    expect(body).not.toHaveProperty('newOwnerUserId');
  });
});

describe('etiketler ve gecmis', () => {
  const closure = (over: Partial<CariClosure> = {}): CariClosure =>
    closureSchema.parse({
      closureId: 'c1',
      unitId: 'u1',
      party: 'occupant',
      moveOutDate: '2026-11-15',
      sourceAccountId: 'recv-u1-occupant',
      userIds: ['kiraci-1'],
      debtTo: 'former',
      advanceTo: 'former',
      lateFee: 0,
      debt: 160000,
      advance: 0,
      items: [],
      membershipChanges: [],
      status: 'completed',
      reason: 'Taşındı',
      createdAt: '2026-11-15T10:00:00.000Z',
      createdBy: 'mgr',
      ...over,
    });

  it('hedef etiketleri tarafa gore konusur', () => {
    expect(debtTargetLabel('occupant', 'former')).toContain('sakin');
    expect(debtTargetLabel('owner', 'former')).toContain('malik');
    expect(advanceTargetLabel('occupant', 'refund')).toContain('iade');
  });

  it('sonuc metni', () => {
    expect(outcomeText(closure(), fmt)).toBe('1600.00 TL borç · Ayrılan sakinin carisinde kalsın');
    expect(outcomeText(closure({ debt: 0, advance: 5000, advanceTo: 'owner' }), fmt)).toBe('50.00 TL avans · Kat maliki carisine aktar');
    expect(outcomeText(closure({ debt: 0 }), fmt)).toBe('Devredilecek bakiye yoktu');
  });

  it('geri al: yalnizca tamamlanmis, iadesiz ve ayni caride sonraki kapama yoksa', () => {
    const a = closure();
    const later = closure({ closureId: 'c2', moveOutDate: '2026-11-20' });
    const otherParty = closure({ closureId: 'c3', moveOutDate: '2026-11-20', sourceAccountId: 'recv-u1-owner', party: 'owner' });
    expect(canOfferReverse(a, [a])).toBe(true);
    expect(canOfferReverse(a, [a, later])).toBe(false);
    expect(canOfferReverse(later, [a, later])).toBe(true);
    expect(canOfferReverse(a, [a, otherParty])).toBe(true);
    expect(canOfferReverse(a, [a, { ...later, status: 'reversed' }])).toBe(true);
    expect(canOfferReverse(closure({ status: 'reversed' }), [])).toBe(false);
    expect(canOfferReverse(closure({ debt: 0, advance: 100, advanceTo: 'refund' }), [])).toBe(false);
  });
});
