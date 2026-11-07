import { describe, expect, it } from 'vitest';
import type { Block, Membership, Person, Unit } from '@/lib/api/units';
import { buildUnitRows, filterRows, formatFloor, landSharePercent } from './unitRows';

const unit = (unitId: string, number: string, blockId = 'b1', extra: Partial<Unit> = {}): Unit => ({
  unitId,
  blockId,
  number,
  type: 'flat',
  grossAreaM2: 100,
  status: 'active',
  version: 1,
  ...extra,
});
const blocks: Block[] = [
  { blockId: 'b1', name: 'A Blok', status: 'active' },
  { blockId: 'b2', name: 'B Blok', status: 'active' },
];
const m = (userId: string, unitId: string, relation: 'owner' | 'tenant', extra: Partial<Membership> = {}): Membership => ({
  userId,
  unitId,
  relation,
  residesInUnit: relation === 'tenant',
  startDate: '2026-01-01',
  status: 'active',
  isCurrent: true,
  ...extra,
});
const people: Person[] = [
  { userId: 'o1', fullName: 'Ayşe Yılmaz', email: 'a@x.com' },
  { userId: 't1', fullName: 'Can Demir', email: 'c@x.com' },
];

describe('buildUnitRows', () => {
  const units = [unit('u1', '1'), unit('u2', '2'), unit('u3', '3', 'b2')];

  it('malik/kiraci adlarini ve doluluk durumunu birlestirir', () => {
    const rows = buildUnitRows(
      units,
      blocks,
      [
        m('o1', 'u1', 'owner', { ownershipShare: { numerator: 1, denominator: 2 } }),
        m('t1', 'u1', 'tenant'),
        m('o1', 'u2', 'owner'), // oturmayan malik: daire bos
        m('t-old', 'u3', 'tenant', { isCurrent: false }), // tasinmis kiraci sayilmaz
        m('ghost', 'u3', 'owner', { residesInUnit: true }), // kisi kaydi olmayan eski uyelik
      ],
      people,
    );
    expect(rows[0]).toMatchObject({
      blockName: 'A Blok',
      owners: [{ name: 'Ayşe Yılmaz', share: '1/2' }],
      tenants: [{ name: 'Can Demir' }],
      occupancy: 'occupied',
    });
    expect(rows[1]?.occupancy).toBe('vacant');
    expect(rows[2]).toMatchObject({ blockName: 'B Blok', tenants: [], owners: [{ name: 'Adı kayıtlı değil' }], occupancy: 'occupied' });
  });

  it('kisi bilgisi yetkisi yoksa durum bilinmiyor', () => {
    expect(buildUnitRows(units, blocks, undefined, undefined)[0]?.occupancy).toBe('unknown');
  });

  it('daire no ve blok adiyla arar (Turkce harf duyarsiz)', () => {
    const rows = buildUnitRows([unit('a', '12'), unit('b', '1'), unit('c', 'İ5')], blocks, [], []);
    expect(filterRows(rows, '1').map((r) => r.unit.number)).toEqual(['12', '1']);
    expect(filterRows(rows, 'i5').map((r) => r.unit.number)).toEqual(['İ5']);
    expect(filterRows(rows, 'a blok 12').map((r) => r.unit.number)).toEqual(['12']);
    expect(filterRows(rows, '  ')).toHaveLength(3);
  });
});

describe('bicimlendirme', () => {
  it('kat', () => {
    expect(formatFloor(undefined)).toBe('—');
    expect(formatFloor(0)).toBe('Zemin');
    expect(formatFloor(-1)).toBe('Bodrum 1');
    expect(formatFloor(4)).toBe('4. kat');
  });
  it('arsa payi yuzdesi', () => {
    expect(landSharePercent({ numerator: 24, denominator: 480 })).toBe('%5');
    expect(landSharePercent(undefined)).toBeUndefined();
  });
});
