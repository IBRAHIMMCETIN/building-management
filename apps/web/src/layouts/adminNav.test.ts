import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { matchesSiteQuery, platformSiteSchema } from '@/lib/api/platform';
import { ADMIN_ROLES, APARTMENT_ADMIN_ROLES, PLATFORM_HOME, homePathForRole } from '@/types/roles';
import { APARTMENT_NAV, PLATFORM_NAV, navItemsFor, panelTitleFor } from './adminNav';

describe('yonetim menusu: platform ve apartman ayrimi', () => {
  it('platform_admin yalnizca platform geneli ogeleri gorur; apartman ekranlari yok', () => {
    const paths = navItemsFor('platform_admin').map((n) => n.to);
    expect(paths).toEqual(['/admin/apartments', '/admin/payments']);
    for (const p of ['/admin', '/admin/units', '/admin/finance', '/admin/announcements', '/admin/import', '/admin/settings']) {
      expect(paths).not.toContain(p);
    }
    expect(panelTitleFor('platform_admin')).toBe('Platform Yönetimi');
  });

  it('apartman rolleri platform ogelerini gormez', () => {
    for (const role of APARTMENT_ADMIN_ROLES) {
      const paths = navItemsFor(role).map((n) => n.to);
      expect(paths).toEqual(APARTMENT_NAV.map((n) => n.to));
      for (const p of PLATFORM_NAV.map((n) => n.to)) expect(paths).not.toContain(p);
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
