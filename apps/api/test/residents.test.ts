import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, encodeMockToken } from '../src/auth/authenticators.js';
import { DataAccessError } from '../src/config/dynamodb.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import type { Unit } from '../src/modules/core/types.js';
import type { MembershipRepository } from '../src/modules/memberships/repository.js';
import { createMembershipService } from '../src/modules/memberships/service.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { createCognitoDirectory, createDirectoryFromEnv, type UserDirectory } from '../src/modules/residents/directory.js';
import type { Person, PersonRepository } from '../src/modules/residents/repository.js';
import { createResidentsService, maskEmail } from '../src/modules/residents/service.js';

const NOW = new Date('2026-11-07T10:00:00.000Z');
const APT = 'apt-1';
const ts = NOW.toISOString();
const audit = { createdAt: ts, createdBy: 'seed', updatedAt: ts, updatedBy: 'seed', version: 1 };

const unit = (id: string, status: Unit['status'] = 'active'): Unit => ({
  PK: `APT#${APT}`,
  SK: `UNIT#${id}`,
  entityType: 'UNIT',
  status,
  ...audit,
  unitId: id,
  siteId: APT,
  blockId: 'b1',
  number: id,
  type: 'flat',
  grossAreaTenthsM2: 1000,
  exemptions: [],
});

function setup(directoryOverride?: UserDirectory) {
  const memberships = new Map<string, UnitMembership>();
  const membershipRepo: MembershipRepository = {
    get: async (apt, user, u) => memberships.get(`${apt}|${user}|${u}`),
    list: async (apt, f = {}) => [...memberships.values()].filter((m) => m.apartmentId === apt && (!f.unitId || m.unitId === f.unitId)),
    create: async (m) => {
      const k = `${m.apartmentId}|${m.userId}|${m.unitId}`;
      if (memberships.has(k)) throw new DataAccessError('conflict', 'var');
      memberships.set(k, m);
    },
    update: async (m) => {
      memberships.set(`${m.apartmentId}|${m.userId}|${m.unitId}`, m);
    },
  };
  const units = [unit('u1'), unit('u2'), unit('old', 'inactive')];
  const core: Pick<CoreRepository, 'getUnit' | 'getBlock' | 'getSite'> = {
    getUnit: async (apt, id) => units.find((u) => u.siteId === apt && u.unitId === id),
    getBlock: async () => undefined,
    getSite: async () => undefined,
  };

  const people = new Map<string, Person>();
  const peopleRepo: PersonRepository = {
    get: async (apt, user) => people.get(`${apt}|${user}`),
    list: async (apt) => [...people.values()].filter((p) => p.apartmentId === apt),
    create: async (p) => {
      if (people.has(`${p.apartmentId}|${p.userId}`)) throw new DataAccessError('conflict', 'var');
      people.set(`${p.apartmentId}|${p.userId}`, p);
    },
    update: async (p, v) => {
      if (people.get(`${p.apartmentId}|${p.userId}`)?.version !== v) throw new DataAccessError('conflict', 'surum');
      people.set(`${p.apartmentId}|${p.userId}`, p);
    },
  };

  const accounts = new Map<string, string>([['mevcut@site.com', 'sub-existing']]);
  const directoryCalls: string[] = [];
  const directory: UserDirectory = directoryOverride ?? {
    findOrCreate: async ({ email }) => {
      directoryCalls.push(email);
      const existing = accounts.get(email);
      if (existing) return { userId: existing, created: false };
      const sub = `sub-${accounts.size + 1}`;
      accounts.set(email, sub);
      return { userId: sub, created: true };
    },
  };

  const membershipService = createMembershipService({ repository: membershipRepo, core, now: () => NOW });
  const residentsService = createResidentsService({
    people: peopleRepo,
    core,
    memberships: membershipService,
    directory,
    now: () => NOW,
  });
  const app = createApp({ version: 'test', authenticate: createMockAuthenticator(), membershipService, residentsService });

  const auth = (role: string, sub = 'mgr-1') => `Bearer ${encodeMockToken({ sub, role, apartmentId: APT })}`;
  const call = async (method: string, path: string, body?: unknown, role = 'apartment_manager') => {
    const res = await app.request(`/api/residents${path}`, {
      method,
      headers: { authorization: auth(role), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  return { call, memberships, people, directoryCalls, app, auth };
}

const tenantInvite = { unitId: 'u1', email: ' Ayse.Yilmaz@Site.com ', fullName: 'Ayşe   Yılmaz', relation: 'tenant' };

describe('POST /api/residents/invite', () => {
  it('yeni kullanici olusturur, uyelik ve kisi kaydi yazar', async () => {
    const t = setup();
    const res = await t.call('POST', '/invite', tenantInvite);
    expect(res.status).toBe(201);
    expect(res.body.invitation).toBe('sent');
    expect(res.body.person).toMatchObject({ fullName: 'Ayşe Yılmaz', email: 'ayse.yilmaz@site.com' });
    expect(res.body.membership).toMatchObject({
      unitId: 'u1',
      relation: 'tenant',
      residesInUnit: true,
      startDate: '2026-11-07', // varsayilan: bugun (Istanbul)
      createdBy: 'mgr-1',
    });
    expect(t.people.size).toBe(1);
  });

  it('mevcut hesabi yeniden kullanir (e-posta gitmez)', async () => {
    const t = setup();
    const res = await t.call('POST', '/invite', { ...tenantInvite, email: 'mevcut@site.com', relation: 'owner', startDate: '2024-05-01' });
    expect(res.status).toBe(201);
    expect(res.body.invitation).toBe('existing_user');
    expect(res.body.membership).toMatchObject({ userId: 'sub-existing', relation: 'owner', startDate: '2024-05-01' });
  });

  it('gecersiz girdide ve pasif dairede Cognito\'ya hic gitmez', async () => {
    const t = setup();
    expect((await t.call('POST', '/invite', { ...tenantInvite, email: 'gecersiz' })).status).toBe(400);
    expect((await t.call('POST', '/invite', { ...tenantInvite, fullName: 'A' })).status).toBe(400);
    expect((await t.call('POST', '/invite', { ...tenantInvite, unitId: 'old' })).status).toBe(404);
    expect((await t.call('POST', '/invite', { ...tenantInvite, unitId: 'yok' })).status).toBe(404);
    expect(t.directoryCalls).toEqual([]);
  });

  it('uyelik kurallari gecerli: ayni kisi ayni daireye ikinci kez atanamaz', async () => {
    const t = setup();
    expect((await t.call('POST', '/invite', tenantInvite)).status).toBe(201);
    const again = await t.call('POST', '/invite', tenantInvite);
    expect(again.status).toBe(409);
    expect(t.memberships.size).toBe(1);
  });

  it('yalnizca yonetici rolleri davet edebilir', async () => {
    const t = setup();
    expect((await t.call('POST', '/invite', tenantInvite, 'observer')).status).toBe(403);
    expect((await t.call('POST', '/invite', tenantInvite, 'resident')).status).toBe(403);
  });

  it('davet servisi yapilandirilmamissa 503', async () => {
    const t = setup(createDirectoryFromEnv({}));
    const res = await t.call('POST', '/invite', tenantInvite);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('invitations_disabled');
  });

  it('ikinci davette ad guncellenir', async () => {
    const t = setup();
    await t.call('POST', '/invite', tenantInvite);
    await t.call('POST', '/invite', { ...tenantInvite, unitId: 'u2', fullName: 'Ayşe Yılmaz Kaya', relation: 'owner' });
    expect([...t.people.values()][0]).toMatchObject({ fullName: 'Ayşe Yılmaz Kaya', version: 2 });
  });
});

describe('GET /api/residents', () => {
  it('kisileri ada gore listeler; denetci e-postayi maskeli gorur', async () => {
    const t = setup();
    await t.call('POST', '/invite', tenantInvite);
    await t.call('POST', '/invite', { ...tenantInvite, unitId: 'u2', email: 'can@site.com', fullName: 'Can Demir' });

    const manager = await t.call('GET', '');
    expect(manager.body.items.map((p: any) => p.fullName)).toEqual(['Ayşe Yılmaz', 'Can Demir']);
    expect(manager.body.items[0].email).toBe('ayse.yilmaz@site.com');

    const observer = await t.call('GET', '', undefined, 'observer');
    expect(observer.body.items[0].email).toBe('a***@site.com');
    expect((await t.call('GET', '', undefined, 'resident')).status).toBe(403);
  });

  it('maskEmail', () => {
    expect(maskEmail('ayse@site.com')).toBe('a***@site.com');
  });
});

describe('createCognitoDirectory', () => {
  const POOL = 'eu-central-1_test';

  it('var olan kullanicinin sub degerini dondurur', async () => {
    const cognito = mockClient(CognitoIdentityProviderClient);
    cognito.on(AdminGetUserCommand).resolves({ Username: 'x', UserAttributes: [{ Name: 'sub', Value: 'sub-1' }] });
    const dir = createCognitoDirectory(POOL, new CognitoIdentityProviderClient({}));
    await expect(dir.findOrCreate({ email: 'a@b.co', fullName: 'A B' })).resolves.toEqual({ userId: 'sub-1', created: false });
    expect(cognito.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
    cognito.restore();
  });

  it('yoksa e-posta + ad ile olusturur ve e-postayla davet gonderir', async () => {
    const cognito = mockClient(CognitoIdentityProviderClient);
    cognito.on(AdminGetUserCommand).rejects(new UserNotFoundException({ message: 'yok', $metadata: {} }));
    cognito.on(AdminCreateUserCommand).resolves({ User: { Attributes: [{ Name: 'sub', Value: 'sub-new' }] } });
    const dir = createCognitoDirectory(POOL, new CognitoIdentityProviderClient({}));
    await expect(dir.findOrCreate({ email: 'a@b.co', fullName: 'A B' })).resolves.toEqual({ userId: 'sub-new', created: true });
    const input = cognito.commandCalls(AdminCreateUserCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ UserPoolId: POOL, Username: 'a@b.co', DesiredDeliveryMediums: ['EMAIL'] });
    expect(input?.UserAttributes).toContainEqual({ Name: 'name', Value: 'A B' });
    cognito.restore();
  });

  it('es zamanli olusturmada mevcut kullaniciyi kullanir', async () => {
    const cognito = mockClient(CognitoIdentityProviderClient);
    cognito
      .on(AdminGetUserCommand)
      .rejectsOnce(new UserNotFoundException({ message: 'yok', $metadata: {} }))
      .resolves({ Username: 'x', UserAttributes: [{ Name: 'sub', Value: 'sub-raced' }] });
    cognito.on(AdminCreateUserCommand).rejects(new UsernameExistsException({ message: 'var', $metadata: {} }));
    const dir = createCognitoDirectory(POOL, new CognitoIdentityProviderClient({}));
    await expect(dir.findOrCreate({ email: 'a@b.co', fullName: 'A B' })).resolves.toEqual({ userId: 'sub-raced', created: false });
    cognito.restore();
  });
});
