import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { matchesSiteQuery, platformSiteSchema } from '@/lib/api/platform';
import { ADMIN_ROLES, APARTMENT_ADMIN_ROLES, PLATFORM_HOME, homePathForRole } from '@/types/roles';
import { APARTMENT_NAV, PLATFORM_NAV, filterNav, navFeatureCheck, navItemsFor, panelTitleFor } from './adminNav';

describe('yonetim menusu: platform ve apartman ayrimi', () => {
  it('platform_admin yalnizca platform geneli ogeleri gorur; apartman ekranlari yok', () => {
    const paths = navItemsFor('platform_admin').map((n) => n.to);
    expect(paths).toEqual([
      '/admin/apartments',
      '/admin/payments',
      '/admin/payments/transfers',
      '/admin/payments/invoices',
      '/admin/billing/subscriptions',
      '/admin/billing/plans',
      '/admin/billing/invoices',
      '/admin/users',
      '/admin/email-suppressions',
      '/admin/demo-requests',
      '/admin/audit',
    ]);
    for (const p of ['/admin', '/admin/units', '/admin/finance', '/admin/announcements', '/admin/import', '/admin/settings']) {
      expect(paths).not.toContain(p);
    }
    expect(panelTitleFor('platform_admin')).toBe('Platform Yönetimi');
  });

  it('apartman rolleri platform ogelerini gormez; denetim/guvenlik yalnizca yetkili rollere', () => {
    expect(navItemsFor('apartment_manager').map((n) => n.to)).toEqual(APARTMENT_NAV.filter((n) => n.to !== '/admin/my-tasks' && !n.portfolioOnly).map((n) => n.to));
    // O1-5: Ariza & Bakim yonetim, gorevli, guvenlik ve denetciye; Islerim yalnizca gorevliye.
    expect(navItemsFor('building_staff').map((n) => n.to)).toEqual(expect.arrayContaining(['/admin/tickets', '/admin/my-tasks']));
    expect(navItemsFor('security_guard').map((n) => n.to)).toContain('/admin/tickets');
    expect(navItemsFor('observer').map((n) => n.to)).not.toContain('/admin/my-tasks');
    expect(navItemsFor('observer').map((n) => n.to)).toContain('/admin/audit');
    expect(navItemsFor('observer').map((n) => n.to)).not.toContain('/admin/security');
    expect(navItemsFor('building_staff').map((n) => n.to)).not.toContain('/admin/audit');
    for (const role of APARTMENT_ADMIN_ROLES) {
      const paths = navItemsFor(role).map((n) => n.to);
      for (const p of ['/admin/apartments', '/admin/payments', '/admin/payments/transfers', '/admin/payments/invoices', '/admin/billing/subscriptions', '/admin/billing/plans', '/admin/billing/invoices', '/admin/users', '/admin/email-suppressions', '/admin/demo-requests']) {
        expect(paths).not.toContain(p);
      }
      expect(panelTitleFor(role)).toBe('Yönetim Paneli');
    }
  });

  it('acilis sayfalari ve rol gruplari', () => {
    expect(homePathForRole('platform_admin')).toBe(PLATFORM_HOME);
    expect(PLATFORM_HOME).toBe('/admin/apartments');
    expect(homePathForRole('apartment_manager')).toBe('/admin');
    expect(homePathForRole('observer')).toBe('/admin');
    expect(homePathForRole('resident')).toBe('/app');
    expect(APARTMENT_ADMIN_ROLES).not.toContain('platform_admin');
    expect([...APARTMENT_ADMIN_ROLES, 'platform_admin'].sort()).toEqual([...ADMIN_ROLES].sort());
  });
});

describe('platform apartman dizini', () => {
  it('Turkce harf duyarsiz arama (ad, ilce, il)', () => {
    const s = { name: 'Işık Apartmanı', district: 'Kadıköy', city: 'İstanbul' };
    expect(matchesSiteQuery(s, 'ışık')).toBe(true);
    expect(matchesSiteQuery(s, 'KADIKÖY')).toBe(true);
    expect(matchesSiteQuery(s, 'istanbul')).toBe(true);
    expect(matchesSiteQuery(s, 'ankara')).toBe(false);
    expect(matchesSiteQuery(s, '  ')).toBe(true);
  });

  it('sema: apartman ici alan tasimaz, bilinmeyen tur reddedilir', () => {
    const site = { siteId: 'a1', tenantId: 't', name: 'Lale', type: 'apartment', city: 'İzmir', district: 'Konak', status: 'active', createdAt: '2026-11-01T10:00:00Z' };
    expect(Object.keys(platformSiteSchema.parse({ ...site, settings: { x: 1 } }))).not.toContain('settings');
    expect(() => platformSiteSchema.parse({ ...site, type: 'villa' })).toThrow();
  });
});

describe('sayac dagitimi menusu (Finans 2.3)', () => {
  it('yonetici iki ekrani; denetci yalnizca dagitimi; bina gorevlisi yalnizca hizli okumayi gorur', () => {
    const paths = (role: Parameters<typeof navItemsFor>[0]) => navItemsFor(role).map((n) => n.to);
    for (const role of ['apartment_manager', 'management_company'] as const) {
      expect(paths(role)).toEqual(expect.arrayContaining(['/admin/meters', '/admin/meter-readings']));
    }
    expect(paths('observer')).toContain('/admin/meters');
    expect(paths('observer')).not.toContain('/admin/meter-readings');
    expect(paths('building_staff')).toContain('/admin/meter-readings');
    expect(paths('building_staff')).not.toContain('/admin/meters');
    expect(paths('security_guard')).not.toContain('/admin/meter-readings');
    expect(paths('platform_admin')).not.toContain('/admin/meters');
  });
});

describe('bina gorevlisi ve guvenlik menu izolasyonu', () => {
  it('bina gorevlisi yalnizca Genel Bakis, Islerim, Ariza & Bakim, Ekipman (salt okur) ve Sayac Okuma gorur', () => {
    expect(navItemsFor('building_staff').map((n) => n.label)).toEqual(['Genel Bakış', 'İşlerim', 'Arıza & Bakım', 'Ekipman', 'Sayaç Okuma']);
  });

  it('guvenlik yalnizca Genel Bakis, Guvenlik Kapisi ve Ariza & Bakim gorur', () => {
    expect(navItemsFor('security_guard').map((n) => n.to)).toEqual(['/admin', '/admin/gate', '/admin/tickets']);
  });

  it('guvenlik kapisi: guvenlik + yonetim; denetci ve bina gorevlisi gormez (KVKK)', () => {
    for (const role of ['apartment_manager', 'management_company', 'security_guard'] as const) expect(navItemsFor(role).map((n) => n.to)).toContain('/admin/gate');
    for (const role of ['observer', 'building_staff', 'platform_admin'] as const) expect(navItemsFor(role).map((n) => n.to)).not.toContain('/admin/gate');
  });

  it('ofis ekranlari yonetici, yonetim firmasi ve denetciye acik kalir', () => {
    for (const role of ['apartment_manager', 'management_company', 'observer'] as const) {
      expect(navItemsFor(role).map((n) => n.to)).toEqual(
        expect.arrayContaining(['/admin/units', '/admin/finance', '/admin/announcements', '/admin/import', '/admin/settings']),
      );
    }
  });
});

describe('yonetim menusu: site ozellik anahtarlari (Adim 1)', () => {
  it('ozellige bagli oge yalnizca ozellik acikken gorunur; varsayilan davranis degismez', () => {
    const items = [
      // Portfoy ogesi (portfolioOnly) gibi gercek menu ogelerinden bagimsiz, sade test ogeleri.
      { to: '/admin/a', label: 'A', icon: APARTMENT_NAV[0]!.icon },
      { to: '/admin/b', label: 'B', icon: APARTMENT_NAV[0]!.icon, roles: ['apartment_manager'] as const, feature: 'admin.debtRestructure' as const },
    ];
    expect(filterNav(items, 'apartment_manager').map((n) => n.to)).toEqual(['/admin/a', '/admin/b']);
    expect(filterNav(items, 'apartment_manager', () => false).map((n) => n.to)).toEqual(['/admin/a']);
    expect(filterNav(items, 'observer', () => true).map((n) => n.to)).toEqual(['/admin/a']);
    // Abonelik plan modulleri (modules.*) menude anahtara bagli; anahtarlar acikken menu aynen.
    expect(navItemsFor('apartment_manager', false, () => false)).toEqual(navItemsFor('apartment_manager').filter((n) => !n.feature));
    expect(navItemsFor('apartment_manager', false, () => true)).toEqual(navItemsFor('apartment_manager'));
    expect(APARTMENT_NAV.filter((n) => n.feature).every((n) => n.feature?.startsWith('modules.'))).toBe(true);
    // Site ozellikleri yuklenirken / okunamazken abonelik modulleri gorunur kalir (onceki davranis).
    for (const status of ['loading', 'error'] as const) {
      expect(navItemsFor('apartment_manager', false, navFeatureCheck(status, () => false))).toEqual(navItemsFor('apartment_manager'));
      expect(navFeatureCheck(status, () => false)('admin.debtRestructure')).toBe(false);
    }
    expect(navFeatureCheck('ready', (k) => k !== 'modules.gate')('modules.gate')).toBe(false);
  });
});
