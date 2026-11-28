import { DEEP_LINK_ROOTS, deepLinkTarget } from './deepLinks';

describe('bildirim baglantilari (push data.url)', () => {
  it('sakin: hazir ekranlar', () => {
    expect(deepLinkTarget('/borclar', 'resident')).toBe('/resident/dues');
    expect(deepLinkTarget('/duyurular', 'resident')).toBe('/resident/announcements');
    expect(deepLinkTarget('/duyurular/an-1', 'resident')).toEqual({ pathname: '/resident/announcements/[id]', params: { id: 'an-1' } });
    expect(deepLinkTarget('/talepler/tk%201', 'resident')).toEqual({ pathname: '/resident/tickets/[id]', params: { id: 'tk 1' } });
    expect(deepLinkTarget('/talepler', 'resident')).toBe('/resident/tickets');
    expect(deepLinkTarget('/kapi', 'resident')).toBe('/resident/gate');
    expect(deepLinkTarget('/rezervasyonlar', 'resident')).toEqual({ pathname: '/resident/reservations', params: { tab: 'mine' } });
  });

  it('sakin: oylama, genel kurul ve ihale yerel ekranlara (ayrinti kimlikle)', () => {
    expect(deepLinkTarget('/oylamalar/p-1', 'resident')).toEqual({ pathname: '/resident/polls/[id]', params: { id: 'p-1' } });
    expect(deepLinkTarget('/oylamalar', 'resident')).toBe('/resident/polls');
    expect(deepLinkTarget('/genel-kurul/as-1', 'resident')).toEqual({ pathname: '/resident/assemblies/[id]', params: { id: 'as-1' } });
    expect(deepLinkTarget('/genel-kurul', 'resident')).toBe('/resident/assemblies');
    expect(deepLinkTarget('/ihaleler/t-1?x=1', 'resident')).toEqual({ pathname: '/resident/tenders/[id]', params: { id: 't-1' } });
    expect(deepLinkTarget('/ihaleler', 'resident')).toBe('/resident/tenders');
  });

  it('saha rolleri ve yonetim kendi alanina gider', () => {
    expect(deepLinkTarget('/kapi', 'guard')).toBe('/guard');
    expect(deepLinkTarget('/talepler/tk-1', 'staff')).toEqual({ pathname: '/staff/ticket/[id]', params: { id: 'tk-1' } });
    expect(deepLinkTarget('/talepler', 'staff')).toBe('/staff');
    expect(deepLinkTarget('/duyurular/an-1', 'staff')).toBe('/staff');
    expect(deepLinkTarget('/talepler/tk-1', 'panel')).toBe('/panel');
  });

  it('bozuk kacis dizili kimlik: hata yerine liste ekrani', () => {
    expect(deepLinkTarget('/duyurular/%E0%A4%A', 'resident')).toBe('/resident/announcements');
    expect(deepLinkTarget('/ihaleler/%ZZ', 'resident')).toBe('/resident/tenders');
  });

  it('bilinmeyen yol veya rolsuz oturum: null (acilis kurali)', () => {
    expect(deepLinkTarget('/bilinmeyen', 'resident')).toBeNull();
    expect(deepLinkTarget('/borclar', null)).toBeNull();
    for (const root of DEEP_LINK_ROOTS) expect(deepLinkTarget(`/${root}`, 'resident')).not.toBeNull();
  });
});
