import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, encodeMockToken } from '../src/auth/authenticators.js';
import { DataAccessError } from '../src/config/dynamodb.js';
import type { ApartmentRoleRepository } from '../src/modules/apartment-roles/repository.js';
import { createApartmentRoleService } from '../src/modules/apartment-roles/service.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import type { Site } from '../src/modules/core/types.js';
import type { UserDirectory } from '../src/modules/residents/directory.js';

/** Faz 1 - Ekip: e-postayla davet, gerekceli bitirme, davet yenileme, son yonetici korumasi. */

const NOW = new Date('2026-11-25T09:00:00.000Z'); // Istanbul: 2026-11-25
const APT = 'apt-1';
const site = { PK: `APT#${APT}`, SK: 'SITE', entityType: 'SITE', siteId: APT, tenantId: 'org-1', name: APT } as unknown as Site;

function role(userId: string, r: ApartmentRole['role'], over: Partial<ApartmentRole> = {}): ApartmentRole {
  return {
    PK: `APT#${APT}`,
    SK: `ROLE#${userId}#${r}`,
    entityType: 'APARTMENT_ROLE',
    userId,
    apartmentId: APT,
    role: r,
    status: 'active',
    startDate: '2026-01-01',
    createdAt: NOW.toISOString(),
    createdBy: 'seed',
    updatedAt: NOW.toISOString(),
    updatedBy: 'seed',
    version: 1,
    ...over,
  };
}

function setup(initial: ApartmentRole[] = [role('mgr-1', 'apartment_manager')]) {
  const items = new Map<string, ApartmentRole>();
  const audits: { action?: string; reason?: string }[] = [];
  const k = (u: string, r: string) => `${u}|${r}`;
  for (const r of initial) items.set(k(r.userId, r.role), r);
  const repo: ApartmentRoleRepository = {
    get: async (_a, u, r) => items.get(k(u, r)),
    list: async () => [...items.values()],
    create: async (r) => {
      if (items.has(k(r.userId, r.role))) throw new DataAccessError('conflict', 'var');
      items.set(k(r.userId, r.role), r);
    },
    update: async (r, v, audit) => {
      if (items.get(k(r.userId, r.role))?.version !== v) throw new DataAccessError('conflict', 'surum');
      items.set(k(r.userId, r.role), r);
      audits.push(audit ?? {});
    },
  };
  const users = new Map<string, string>([['mevcut@x.com', 'user-existing']]);
  const resent: string[] = [];
  const directory: UserDirectory = {
    kind: 'cognito',
    async findOrCreate({ email }) {
      const found = users.get(email);
      if (found) return { userId: found, created: false };
      const id = `user-${users.size + 1}`;
      users.set(email, id);
      return { userId: id, created: true };
    },
    async resendInvitation(email) {
      resent.push(email);
      return email === 'aktif@x.com' ? 'not_pending' : 'sent';
    },
  };
  const service = createApartmentRoleService({ repository: repo, core: { getSite: async () => site }, directory, now: () => NOW });
  const app = createApp({ version: 'test', authenticate: createMockAuthenticator(), apartmentRoleService: service });
  const token = (sub: string, r: string) => `Bearer ${encodeMockToken({ sub, role: r, apartmentId: APT })}`;
  const call = async (method: string, path: string, body?: unknown, auth = token('mgr-1', 'apartment_manager')) => {
    const res = await app.request(`/api/apartment-roles${path}`, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { items, audits, resent, call, token };
}

describe('ekip daveti', () => {
  it('yeni kisi: Cognito kullanicisi olusur, kayit ad/e-posta ile yazilir (201, sent)', async () => {
    const { call, items } = setup();
    const res = await call('POST', '/invite', { email: ' Kapici@X.com ', fullName: 'Ali  Kapıcı', role: 'building_staff' });
    expect(res.status).toBe(201);
    expect(res.body.invitation).toBe('sent');
    expect(res.body.role).toMatchObject({ role: 'building_staff', fullName: 'Ali Kapıcı', email: 'kapici@x.com', status: 'active', startDate: '2026-11-25', isCurrent: true });
    expect(res.body.role.PK).toBeUndefined();
    expect(items.get(`${res.body.role.userId}|building_staff`)?.displayName).toBe('Ali Kapıcı');
  });

  it('var olan kullanici: e-posta gitmez; ayni rol aktifse 409, pasifse yeniden etkinlestirilir (200)', async () => {
    const { call, items } = setup([role('mgr-1', 'apartment_manager'), role('user-existing', 'observer', { status: 'inactive', endDate: '2026-06-01', endReason: 'Görev süresi bitti' })]);
    const re = await call('POST', '/invite', { email: 'mevcut@x.com', fullName: 'Veli Denetçi', role: 'observer' });
    expect(re.status).toBe(200);
    expect(re.body).toMatchObject({ invitation: 'existing_user', reactivated: true });
    const rec = items.get('user-existing|observer');
    expect(rec).toMatchObject({ status: 'active', startDate: '2026-11-25', version: 2 });
    expect(rec?.endDate).toBeUndefined();
    expect(rec?.endReason).toBeUndefined();
    expect((await call('POST', '/invite', { email: 'mevcut@x.com', fullName: 'Veli Denetçi', role: 'observer' })).status).toBe(409);
  });

  it('dogrulama ve yetki: gecersiz e-posta 400, yonetici firma rolu atayamaz, denetci davet edemez, kendini davet edemez', async () => {
    const { call, token } = setup();
    expect((await call('POST', '/invite', { email: 'x', fullName: 'Ad Soyad', role: 'observer' })).status).toBe(400);
    expect((await call('POST', '/invite', { email: 'a@b.com', fullName: 'Ad Soyad', role: 'management_company' })).status).toBe(403);
    expect((await call('POST', '/invite', { email: 'a@b.com', fullName: 'Ad Soyad', role: 'observer' }, token('o', 'observer'))).status).toBe(403);
    const self = setup([role('user-existing', 'apartment_manager')]);
    const res = await self.call('POST', '/invite', { email: 'mevcut@x.com', fullName: 'Ben', role: 'observer' }, self.token('user-existing', 'apartment_manager'));
    expect(res.status).toBe(403);
  });

  it('denetci listede e-postayi maskeli gorur', async () => {
    const { call, token } = setup([role('mgr-1', 'apartment_manager'), role('s1', 'building_staff', { email: 'kapici@site.com', fullName: 'Ali' })]);
    const res = await call('GET', '', undefined, token('o', 'observer'));
    expect(res.body.items.find((i: any) => i.userId === 's1').email).toBe('k***@site.com');
    const mgr = await call('GET', '');
    expect(mgr.body.items.find((i: any) => i.userId === 's1').email).toBe('kapici@site.com');
  });
});

describe('rol bitirme ve son yonetici korumasi', () => {
  it('gerekceli bitirme: bugun -> pasif, gerekce denetime yazilir; ileri tarih -> planli bitis', async () => {
    const { call, items, audits } = setup([role('mgr-1', 'apartment_manager'), role('s1', 'building_staff'), role('s2', 'security_guard')]);
    expect((await call('POST', '/s1/building_staff/end', { version: 1, reason: 'kısa' })).status).toBe(400);
    const now = await call('POST', '/s1/building_staff/end', { version: 1, reason: 'Sözleşme sona erdi' });
    expect(now.status).toBe(200);
    expect(now.body).toMatchObject({ status: 'inactive', endDate: '2026-11-25', endReason: 'Sözleşme sona erdi', isCurrent: false });
    expect(audits.at(-1)).toEqual({ action: 'apartment_role.end', reason: 'Sözleşme sona erdi' });
    expect((await call('POST', '/s1/building_staff/end', { version: 2, reason: 'Tekrar bitir' })).status).toBe(409);

    const later = await call('POST', '/s2/security_guard/end', { version: 1, reason: 'Ay sonunda ayrılıyor', endDate: '2026-11-30' });
    expect(later.body).toMatchObject({ status: 'active', endDate: '2026-11-30', isCurrent: true });
    expect(items.get('s2|security_guard')?.version).toBe(2);
    // Surum uyusmazligi
    expect((await call('POST', '/s2/security_guard/end', { version: 1, reason: 'Eski surum' })).status).toBe(409);
  });

  it('son yoneticiyi bitirme / pasife alma / bitis tarihini one cekme 409; baska yonetici varsa izinli', async () => {
    const one = setup([role('mgr-1', 'apartment_manager'), role('mgr-2', 'apartment_manager', { endDate: '2026-11-25' })]);
    // mgr-2 bugun bitiyor; mgr-1 kendi kaydina dokunamaz, firma mgr-1'i bitirmek isterse son yonetici kalmaz.
    const company = one.token('cmp-1', 'management_company');
    const end = await one.call('POST', '/mgr-1/apartment_manager/end', { version: 1, reason: 'Görev devri yapılıyor' }, company);
    expect(end.status).toBe(409);
    expect(end.body.message).toContain('en az bir aktif yönetici');
    expect((await one.call('DELETE', '/mgr-1/apartment_manager', undefined, company)).status).toBe(409);
    expect((await one.call('PATCH', '/mgr-1/apartment_manager', { version: 1, endDate: '2026-12-01' }, company)).status).toBe(409);

    const two = setup([role('mgr-1', 'apartment_manager'), role('mgr-2', 'apartment_manager')]);
    const ok = await two.call('POST', '/mgr-2/apartment_manager/end', { version: 1, reason: 'Yönetim kurulu değişti' });
    expect(ok.status).toBe(200);
    // Kendi kaydi her durumda korunur.
    expect((await two.call('POST', '/mgr-1/apartment_manager/end', { version: 1, reason: 'Kendimi bitiriyorum' })).status).toBe(403);
  });

  it('yonetim firmasi kaydi da yonetici sayilir', async () => {
    const { call } = setup([role('mgr-1', 'apartment_manager'), role('mgr-2', 'apartment_manager'), role('cmp-1', 'management_company')]);
    expect((await call('POST', '/mgr-2/apartment_manager/end', { version: 1, reason: 'Firma yönetiyor' })).status).toBe(200);
  });
});

describe('davet yenileme', () => {
  it('e-postasi olan aktif kayda gonderir; hesabi etkin kullanicida not_pending; pasif kayit 409', async () => {
    const { call, resent } = setup([
      role('mgr-1', 'apartment_manager'),
      role('s1', 'building_staff', { email: 'kapici@x.com' }),
      role('s2', 'building_staff', { email: 'aktif@x.com' }),
      role('s3', 'observer', { email: 'eski@x.com', status: 'inactive' }),
      role('s4', 'observer'),
    ]);
    expect((await call('POST', '/s1/building_staff/resend-invite')).body).toEqual({ result: 'sent' });
    expect((await call('POST', '/s2/building_staff/resend-invite')).body).toEqual({ result: 'not_pending' });
    expect((await call('POST', '/s3/observer/resend-invite')).status).toBe(409);
    expect((await call('POST', '/s4/observer/resend-invite')).status).toBe(400);
    expect(resent).toEqual(['kapici@x.com', 'aktif@x.com']);
  });
});
