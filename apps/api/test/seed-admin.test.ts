import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { type SeedDeps, parseCli, seedAdmin } from '../scripts/seed-admin.js';
import { DataAccessError } from '../src/config/dynamodb.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import type { Site } from '../src/modules/core/types.js';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const POOL = 'eu-central-1_abc';
const cognito = mockClient(CognitoIdentityProviderClient);

const notFound = () => new UserNotFoundException({ message: 'yok', $metadata: {} });

function setup(existingSites: Partial<Site>[] = []) {
  const roles: ApartmentRole[] = [];
  const sites: { siteId: string; name: string; tenantId: string }[] = [];
  const logs: string[] = [];
  const deps: SeedDeps = {
    cognito: new CognitoIdentityProviderClient({ region: 'eu-central-1' }),
    roles: {
      create: async (r) => {
        if (roles.some((x) => x.SK === r.SK && x.PK === r.PK)) throw new DataAccessError('conflict', 'var');
        roles.push(r);
      },
    },
    core: { getSite: async (id) => existingSites.find((s) => s.siteId === id) as Site | undefined },
    createSite: async (_actor, tenantId, input) => {
      const s = { siteId: `site-${sites.length + 1}`, name: (input as { name: string }).name, tenantId };
      sites.push(s);
      return s;
    },
    now: () => NOW,
    log: (l) => logs.push(l),
  };
  return { deps, roles, sites, logs };
}

const site = { name: 'Lale Apt', city: 'Istanbul', district: 'Kadikoy', address: 'Moda 1', type: 'apartment' as const };

beforeEach(() => cognito.reset());

describe('seedAdmin', () => {
  it('yeni platform_admin + yeni site + yonetici: Cognito ve DynamoDB kayitlari', async () => {
    cognito.on(AdminGetUserCommand).rejects(notFound());
    cognito
      .on(AdminCreateUserCommand, { Username: 'ops@x.com' })
      .resolves({ User: { Attributes: [{ Name: 'sub', Value: 'sub-admin' }] } })
      .on(AdminCreateUserCommand, { Username: 'mgr@x.com' })
      .resolves({ User: { Attributes: [{ Name: 'sub', Value: 'sub-mgr' }] } });
    cognito.on(AdminAddUserToGroupCommand).resolves({});
    cognito.on(AdminUpdateUserAttributesCommand).resolves({});
    const { deps, roles, sites } = setup();

    const result = await seedAdmin(
      { userPoolId: POOL, adminEmail: 'ops@x.com', managerEmail: 'mgr@x.com', site, tenantId: 'org-1' },
      deps,
    );

    expect(result).toEqual({
      admin: { email: 'ops@x.com', userId: 'sub-admin', created: true },
      site: { siteId: 'site-1', name: 'Lale Apt', created: true },
      manager: { email: 'mgr@x.com', userId: 'sub-mgr', created: true, roleCreated: true },
    });
    expect(sites[0]?.tenantId).toBe('org-1');
    expect(cognito.commandCalls(AdminAddUserToGroupCommand)[0]!.args[0].input).toEqual({
      UserPoolId: POOL,
      Username: 'ops@x.com',
      GroupName: 'platform_admin',
    });
    expect(cognito.commandCalls(AdminCreateUserCommand)[0]!.args[0].input).toMatchObject({
      DesiredDeliveryMediums: ['EMAIL'],
      UserAttributes: expect.arrayContaining([{ Name: 'email_verified', Value: 'true' }]),
    });
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({
      PK: 'APT#site-1',
      SK: 'ROLE#sub-mgr#apartment_manager',
      entityType: 'APARTMENT_ROLE',
      role: 'apartment_manager',
      userId: 'sub-mgr',
      apartmentId: 'site-1',
      status: 'active',
      startDate: '2026-11-06',
    });
    expect(cognito.commandCalls(AdminUpdateUserAttributesCommand)[0]!.args[0].input.UserAttributes).toEqual([
      { Name: 'custom:active_apartment', Value: 'site-1' },
      { Name: 'custom:active_role', Value: 'apartment_manager' },
    ]);
  });

  it('idempotent: var olan kullanici ve rol korunur, var olan siteye eklenir', async () => {
    cognito.on(AdminGetUserCommand).resolves({ UserAttributes: [{ Name: 'sub', Value: 'sub-mgr' }] });
    cognito.on(AdminUpdateUserAttributesCommand).resolves({});
    const { deps, roles, sites } = setup([{ siteId: 'apt-9', name: 'Mevcut' }]);
    const opts = { userPoolId: POOL, managerEmail: 'mgr@x.com', apartmentId: 'apt-9' };

    const first = await seedAdmin(opts, deps);
    const second = await seedAdmin(opts, deps);

    expect(first.manager).toMatchObject({ created: false, roleCreated: true });
    expect(second.manager).toMatchObject({ created: false, roleCreated: false });
    expect(roles).toHaveLength(1);
    expect(sites).toHaveLength(0);
    expect(cognito.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });

  it('dry-run hicbir sey yazmaz', async () => {
    cognito.on(AdminGetUserCommand).rejects(notFound());
    const { deps, roles, sites } = setup();
    const result = await seedAdmin(
      { userPoolId: POOL, adminEmail: 'ops@x.com', managerEmail: 'mgr@x.com', site, dryRun: true },
      deps,
    );
    expect(result.site?.created).toBe(true);
    expect(roles).toHaveLength(0);
    expect(sites).toHaveLength(0);
    expect(cognito.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
    expect(cognito.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(0);
    expect(cognito.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);
  });

  it.each([
    ['e-posta yok', { userPoolId: POOL }, /En az biri/],
    ['gecersiz e-posta', { userPoolId: POOL, adminEmail: 'x' }, /Gecersiz e-posta/],
    ['yonetici icin site yok', { userPoolId: POOL, managerEmail: 'm@x.com' }, /apartment-id/],
    ['ikisi birden', { userPoolId: POOL, managerEmail: 'm@x.com', apartmentId: 'a', site }, /birlikte/],
  ])('hata: %s', async (_l, opts, msg) => {
    const { deps } = setup();
    await expect(seedAdmin(opts, deps)).rejects.toThrow(msg);
  });

  it('olmayan apartmentId hata verir', async () => {
    cognito.on(AdminGetUserCommand).resolves({ UserAttributes: [{ Name: 'sub', Value: 's' }] });
    const { deps } = setup();
    await expect(seedAdmin({ userPoolId: POOL, managerEmail: 'm@x.com', apartmentId: 'yok' }, deps)).rejects.toThrow(
      /Site bulunamadi/,
    );
  });
});

describe('parseCli', () => {
  it('argumanlari ve ortam degiskenini okur', () => {
    const o = parseCli(
      ['--manager-email', 'm@x.com', '--site-name', 'Lale', '--city', 'Ist', '--district', 'Kad', '--address', 'Moda', '--dry-run'],
      { COGNITO_USER_POOL_ID: POOL },
    );
    expect(o).toMatchObject({
      userPoolId: POOL,
      managerEmail: 'm@x.com',
      dryRun: true,
      site: { name: 'Lale', city: 'Ist', district: 'Kad', address: 'Moda', type: 'apartment' },
    });
  });

  it('eksik havuz, eksik site alanlari ve bilinmeyen arguman hata verir', () => {
    expect(() => parseCli(['--admin-email', 'a@x.com'], {})).toThrow(/COGNITO_USER_POOL_ID/);
    expect(() => parseCli(['--site-name', 'L'], { COGNITO_USER_POOL_ID: POOL })).toThrow(/--city/);
    expect(() => parseCli(['--bilinmeyen'], { COGNITO_USER_POOL_ID: POOL })).toThrow();
  });
});
