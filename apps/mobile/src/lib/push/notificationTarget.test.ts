import type { SelectableContext } from '@bm/shared/auth/contextsSchema';
import { UNAVAILABLE_NOTICE, notificationUrl, resolveNotificationTarget } from './notificationTarget';

/* Bildirime dokunma: baglam dogrulamasi (yalnizca kullanicinin baglamlarindaki apartmana gecilir). */

const ctx = (apartmentId: string, role: SelectableContext['role']): SelectableContext => ({ apartmentId, apartmentName: apartmentId, role });
const active = { apartmentId: 'apt-1', role: 'resident' };
const contexts = [ctx('apt-1', 'resident'), ctx('apt-2', 'resident'), ctx('apt-2', 'building_staff'), ctx('apt-3', 'building_staff')];

describe('bildirim hedefi', () => {
  it('yalnizca uygulamanin karsiladigi ic yollar', () => {
    expect(notificationUrl({ url: '/duyurular/an-1' })).toBe('/duyurular/an-1');
    expect(notificationUrl({ url: 'https://evil.test/borclar' })).toBeNull();
    expect(notificationUrl({ url: '//evil.test/borclar' })).toBeNull();
    expect(notificationUrl({ url: '/admin/finance' })).toBeNull();
    expect(notificationUrl({ url: 42 })).toBeNull();
    expect(resolveNotificationTarget({ url: '/bilinmeyen' }, { active, contexts })).toEqual({ kind: 'ignore' });
  });

  it('apartman yok veya aktif apartman: dogrudan yol', () => {
    expect(resolveNotificationTarget({ url: '/borclar' }, { active, contexts })).toEqual({ kind: 'navigate', url: '/borclar' });
    expect(resolveNotificationTarget({ url: '/borclar', apartmentId: 'apt-1' }, { active, contexts })).toEqual({ kind: 'navigate', url: '/borclar' });
  });

  it('baglamlardaki baska apartman: once ayni rol, yoksa yola uygun rol', () => {
    expect(resolveNotificationTarget({ url: '/duyurular/an-9', apartmentId: 'apt-2' }, { active, contexts })).toEqual({
      kind: 'switch',
      context: { apartmentId: 'apt-2', role: 'resident' },
      url: '/duyurular/an-9',
    });
    // Aktif rol (sakin) o apartmanda yok: talep bildirimi gorevli baglamini secer.
    expect(resolveNotificationTarget({ url: '/talepler/tk-1', apartmentId: 'apt-3' }, { active, contexts })).toEqual({
      kind: 'switch',
      context: { apartmentId: 'apt-3', role: 'building_staff' },
      url: '/talepler/tk-1',
    });
    expect(resolveNotificationTarget({ url: '/talepler/tk-1', apartmentId: 'apt-2' }, { active: { apartmentId: 'apt-3', role: 'security_guard' }, contexts })).toMatchObject({
      context: { apartmentId: 'apt-2', role: 'building_staff' },
    });
  });

  it('baglamlarda olmayan apartman: gecis yok, ana sayfa + bilgi notu', () => {
    expect(resolveNotificationTarget({ url: '/borclar', apartmentId: 'apt-x' }, { active, contexts })).toEqual({ kind: 'unavailable', message: UNAVAILABLE_NOTICE });
    expect(resolveNotificationTarget({ url: '/kapi', apartmentId: 'apt-2' }, { active, contexts: [] })).toEqual({ kind: 'unavailable', message: UNAVAILABLE_NOTICE });
  });
});
