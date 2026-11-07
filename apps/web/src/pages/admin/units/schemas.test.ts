import { describe, expect, it } from 'vitest';
import { NEW_BLOCK, createUnitSchema, inviteSchema } from './schemas';

const base = { blockId: 'b1', newBlockName: '', number: '5', type: 'flat', floor: '', grossAreaM2: '85,5', landShareNumerator: '', landShareDenominator: '' };

describe('createUnitSchema', () => {
  it('virgullu m2 ve bos opsiyonel alanlari donusturur', () => {
    const r = createUnitSchema.parse({ ...base, floor: '-1' });
    expect(r).toMatchObject({ grossAreaM2: 85.5, floor: -1, landShareNumerator: undefined });
  });

  it('zorunlu alanlar ve sinirlar', () => {
    const r = createUnitSchema.safeParse({ ...base, number: ' ', grossAreaM2: '', floor: '2.5' });
    const paths = r.error?.issues.map((i) => i.path[0]);
    expect(paths).toEqual(expect.arrayContaining(['number', 'grossAreaM2', 'floor']));
  });

  it('arsa payi pay/payda birlikte ve pay <= payda', () => {
    expect(createUnitSchema.safeParse({ ...base, landShareNumerator: '24' }).error?.issues[0]?.path).toEqual(['landShareDenominator']);
    expect(createUnitSchema.safeParse({ ...base, landShareNumerator: '500', landShareDenominator: '480' }).success).toBe(false);
    expect(createUnitSchema.parse({ ...base, landShareNumerator: '24', landShareDenominator: '480' })).toMatchObject({
      landShareNumerator: 24,
      landShareDenominator: 480,
    });
  });

  it('yeni blok secildiyse ad zorunlu', () => {
    expect(createUnitSchema.safeParse({ ...base, blockId: NEW_BLOCK }).error?.issues[0]?.path).toEqual(['newBlockName']);
    expect(createUnitSchema.safeParse({ ...base, blockId: NEW_BLOCK, newBlockName: 'A Blok' }).success).toBe(true);
  });
});

describe('inviteSchema', () => {
  const invite = { fullName: 'Ayşe Yılmaz', email: ' Ayse@Site.COM ', relation: 'tenant', startDate: '2026-11-07', residesInUnit: false, shareNumerator: '', shareDenominator: '' };

  it('e-postayi normalize eder', () => {
    expect(inviteSchema.parse(invite).email).toBe('ayse@site.com');
  });

  it('gecersiz e-posta, kisa ad, gecersiz tarih', () => {
    const r = inviteSchema.safeParse({ ...invite, email: 'x', fullName: 'A', startDate: '2026-13-01' });
    expect(r.error?.issues.map((i) => i.path[0])).toEqual(expect.arrayContaining(['email', 'fullName', 'startDate']));
  });

  it('malikte hisse payi kontrol edilir, kiracida yok sayilir', () => {
    expect(inviteSchema.safeParse({ ...invite, relation: 'owner', shareNumerator: '1' }).success).toBe(false);
    expect(inviteSchema.safeParse({ ...invite, relation: 'tenant', shareNumerator: '1' }).success).toBe(true);
    expect(inviteSchema.parse({ ...invite, relation: 'owner', shareNumerator: '1', shareDenominator: '2' })).toMatchObject({
      shareNumerator: 1,
      shareDenominator: 2,
    });
  });
});
