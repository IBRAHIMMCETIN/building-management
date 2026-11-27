import { describe, expect, it } from 'vitest';
import { PRIMARY_TABS, RESIDENT_NAV, isMoreActive, splitResidentNav } from './residentNav';

describe('sakin menusu: alt sekmeler ve "Diğer"', () => {
  it('ilk dort oge alt cubukta, kalanlar cekmecede', () => {
    const { primary, more } = splitResidentNav();
    expect(primary.map((n) => n.label)).toEqual(['Ana Sayfa', 'Borçlarım', 'Talepler', 'Duyurular']);
    expect(more.map((n) => n.to)).toEqual(['/app/ziyaretci', '/app/rezervasyon', '/app/oylamalar', '/app/genel-kurul', '/app/tuketim']);
    expect(primary.length + more.length).toBe(RESIDENT_NAV.length);
  });

  it('cekmeceye tek oge kalacaksa hepsi cubukta gosterilir', () => {
    const five = RESIDENT_NAV.slice(0, PRIMARY_TABS + 1);
    expect(splitResidentNav(five).more).toEqual([]);
    expect(splitResidentNav(five).primary).toHaveLength(PRIMARY_TABS + 1);
  });

  it('"Diğer" yalnizca cekmecedeki sayfa veya alt sayfasi acikken aktif', () => {
    const { more } = splitResidentNav();
    expect(isMoreActive('/app/rezervasyon', more)).toBe(true);
    expect(isMoreActive('/app/ziyaretci/abc', more)).toBe(true);
    expect(isMoreActive('/app/oylamalar/poll-1', more)).toBe(true);
    expect(isMoreActive('/app/genel-kurul/asm-1', more)).toBe(true);
    expect(isMoreActive('/app/ziyaretciler', more)).toBe(false);
    expect(isMoreActive('/app/dues', more)).toBe(false);
    expect(isMoreActive('/app', more)).toBe(false);
  });
});
