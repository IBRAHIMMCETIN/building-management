import type { Block, Membership, Person, Unit } from '@/lib/api/units';

export type RowParty = { userId: string; name: string; share?: string };

export type UnitRow = {
  unit: Unit;
  blockName: string;
  owners: RowParty[];
  tenants: RowParty[];
  /**
   * occupied: dairede oturan biri var (kiraci veya oturan malik).
   * unknown: kisi bilgisini gorme yetkisi yok (bina gorevlisi) - durum hesaplanamaz.
   */
  occupancy: 'occupied' | 'vacant' | 'unknown';
};

/** Saf birlestirme: daire + blok + guncel uyelikler + kisi adlari -> tablo satirlari. */
export function buildUnitRows(
  units: Unit[],
  blocks: Block[],
  memberships: Membership[] | undefined,
  people: Person[] | undefined,
): UnitRow[] {
  const blockNames = new Map(blocks.map((b) => [b.blockId, b.name]));
  const names = new Map((people ?? []).map((p) => [p.userId, p.fullName]));
  const byUnit = new Map<string, Membership[]>();
  for (const m of memberships ?? []) {
    if (!m.isCurrent || m.status !== 'active') continue;
    byUnit.set(m.unitId, [...(byUnit.get(m.unitId) ?? []), m]);
  }

  const party = (m: Membership): RowParty => ({
    userId: m.userId,
    // Davet ucu disinda (eski kayitlar) eklenmis kisilerin adi olmayabilir.
    name: names.get(m.userId) ?? 'Adı kayıtlı değil',
    share: m.ownershipShare ? `${m.ownershipShare.numerator}/${m.ownershipShare.denominator}` : undefined,
  });

  return units.map((unit) => {
    const current = byUnit.get(unit.unitId) ?? [];
    return {
      unit,
      blockName: blockNames.get(unit.blockId) ?? '—',
      owners: current.filter((m) => m.relation === 'owner').map(party),
      tenants: current.filter((m) => m.relation === 'tenant').map(party),
      occupancy: memberships === undefined ? 'unknown' : current.some((m) => m.residesInUnit) ? 'occupied' : 'vacant',
    };
  });
}

/** Daire no aramasi: buyuk/kucuk harf ve Turkce karakter duyarsiz, bas kisim eslesmesi + blok adi. */
export function filterRows(rows: UnitRow[], query: string): UnitRow[] {
  const q = query.trim().toLocaleLowerCase('tr');
  if (!q) return rows;
  return rows.filter((r) => {
    const number = r.unit.number.toLocaleLowerCase('tr');
    const label = `${r.blockName} ${r.unit.number}`.toLocaleLowerCase('tr');
    return number.includes(q) || label.includes(q);
  });
}

export function formatLandShare(share: Unit['landShare']): string {
  return share ? `${share.numerator}/${share.denominator}` : '—';
}

export function landSharePercent(share: Unit['landShare']): string | undefined {
  if (!share) return undefined;
  return `%${((share.numerator / share.denominator) * 100).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}`;
}

export function formatFloor(floor: number | undefined): string {
  if (floor === undefined) return '—';
  if (floor === 0) return 'Zemin';
  return floor < 0 ? `Bodrum ${Math.abs(floor)}` : `${floor}. kat`;
}
