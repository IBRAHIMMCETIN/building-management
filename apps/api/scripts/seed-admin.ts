/**
 * Ilk kurulum (bootstrap) betigi: ilk platform_admin ve ilk apartment_manager.
 *
 * Neden gerekli? API'deki tum yazma uclari bir apartman baglami (JWT apartmentId + rol)
 * ister; hic yonetici yokken ilk siteyi ve ilk yoneticiyi API uzerinden olusturmak mumkun
 * degildir. Bu betik dogrudan Cognito + DynamoDB'ye yazar ve IDEMPOTENT'tir: tekrar
 * calistirmak mevcut kullanici/rol kayitlarini korur.
 *
 * Kullanim (apps/api icinde, Terraform ciktilariyla):
 *   export AWS_REGION=eu-central-1
 *   export COGNITO_USER_POOL_ID=$(terraform -chdir=../../infra output -raw cognito_user_pool_id)
 *   export DYNAMODB_TABLE_NAME=$(terraform -chdir=../../infra output -raw dynamodb_table_name)
 *
 *   npm run seed:admin -- --admin-email ops@ornek.com \
 *     --manager-email yonetici@ornek.com \
 *     --site-name "Lale Apartmani" --city Istanbul --district Kadikoy --address "Moda Cd. 1"
 *
 *   # Var olan siteye yonetici eklemek icin: --apartment-id <siteId>
 *   # Yalnizca planlamak icin: --dry-run
 *
 * Kullanicilara Cognito gecici sifre e-postasi gonderir (ilk giriste sifre degistirilir).
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { DataAccessError } from '../src/config/dynamodb.js';
import { type ApartmentRoleRepository, apartmentRoleKeys, apartmentRoleRepository } from '../src/modules/apartment-roles/repository.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import { type CoreRepository, coreRepository } from '../src/modules/core/repository.js';
import { createCoreService } from '../src/modules/core/service.js';

export type SeedOptions = {
  userPoolId: string;
  adminEmail?: string;
  managerEmail?: string;
  apartmentId?: string;
  site?: { name: string; city: string; district: string; address: string; type: 'apartment' | 'site' | 'residence' };
  /** Sitenin bagli oldugu yonetim firmasi / tenant; verilmezse yeni kimlik uretilir. */
  tenantId?: string;
  dryRun?: boolean;
};

type CognitoSend = Pick<CognitoIdentityProviderClient, 'send'>;

export type SeedDeps = {
  cognito: CognitoSend;
  roles: Pick<ApartmentRoleRepository, 'create'>;
  core: Pick<CoreRepository, 'getSite'>;
  createSite: (actor: string, tenantId: string, input: unknown) => Promise<{ siteId: string; name: string }>;
  now: () => Date;
  log: (line: string) => void;
};

export type SeedResult = {
  admin?: { email: string; userId: string; created: boolean };
  manager?: { email: string; userId: string; created: boolean; roleCreated: boolean };
  site?: { siteId: string; name: string; created: boolean };
};

const ACTOR = 'seed-admin';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function attr(attrs: { Name?: string; Value?: string }[] | undefined, name: string): string | undefined {
  return attrs?.find((a) => a.Name === name)?.Value;
}

/** Kullaniciyi e-postayla bulur; yoksa olusturur (gecici sifre e-postasi gider). */
async function ensureUser(
  deps: SeedDeps,
  userPoolId: string,
  email: string,
  dryRun: boolean,
): Promise<{ userId: string; created: boolean }> {
  try {
    const out = await deps.cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
    const sub = attr(out.UserAttributes, 'sub');
    if (!sub) throw new Error(`Cognito kullanicisinda sub yok: ${email}`);
    return { userId: sub, created: false };
  } catch (err) {
    if (!(err instanceof UserNotFoundException)) throw err;
  }
  if (dryRun) return { userId: `<yeni:${email}>`, created: true };

  const out = await deps.cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
    }),
  );
  const sub = attr(out.User?.Attributes, 'sub');
  if (!sub) throw new Error(`Olusturulan kullanicida sub yok: ${email}`);
  deps.log(`Cognito kullanicisi olusturuldu: ${email}`);
  return { userId: sub, created: true };
}

export async function seedAdmin(options: SeedOptions, deps: SeedDeps): Promise<SeedResult> {
  const { userPoolId, dryRun = false } = options;
  if (!options.adminEmail && !options.managerEmail) {
    throw new Error('En az biri gerekli: --admin-email veya --manager-email');
  }
  for (const email of [options.adminEmail, options.managerEmail]) {
    if (email && !EMAIL_RE.test(email)) throw new Error(`Gecersiz e-posta: ${email}`);
  }
  if (options.managerEmail && !options.apartmentId && !options.site) {
    throw new Error('Yonetici icin --apartment-id veya --site-name (yeni site) gerekli');
  }
  if (options.apartmentId && options.site) {
    throw new Error('--apartment-id ve --site-name birlikte kullanilamaz');
  }

  const result: SeedResult = {};

  // 1) platform_admin (Cognito group)
  if (options.adminEmail) {
    const admin = await ensureUser(deps, userPoolId, options.adminEmail, dryRun);
    if (!dryRun) {
      await deps.cognito.send(
        new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: options.adminEmail, GroupName: 'platform_admin' }),
      );
    }
    deps.log(`platform_admin hazir: ${options.adminEmail}`);
    result.admin = { email: options.adminEmail, ...admin };
  }

  if (!options.managerEmail) return result;

  // 2) Site (var olan veya yeni)
  let site: { siteId: string; name: string; created: boolean };
  if (options.apartmentId) {
    const existing = await deps.core.getSite(options.apartmentId);
    if (!existing) throw new Error(`Site bulunamadi: ${options.apartmentId}`);
    site = { siteId: existing.siteId, name: existing.name, created: false };
  } else {
    const s = options.site as NonNullable<SeedOptions['site']>;
    if (dryRun) {
      site = { siteId: '<yeni-site>', name: s.name, created: true };
    } else {
      const created = await deps.createSite(ACTOR, options.tenantId ?? randomUUID(), {
        name: s.name,
        type: s.type,
        address: { line1: s.address, district: s.district, city: s.city },
      });
      site = { siteId: created.siteId, name: created.name, created: true };
      deps.log(`Site olusturuldu: ${created.name} (${created.siteId})`);
    }
  }
  result.site = site;

  // 3) apartment_manager rol kaydi (GSI1 ile Pre Token Lambda okur)
  const manager = await ensureUser(deps, userPoolId, options.managerEmail, dryRun);
  let roleCreated = false;
  if (!dryRun) {
    const ts = deps.now().toISOString();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());
    const record: ApartmentRole = {
      ...apartmentRoleKeys.role(site.siteId, manager.userId, 'apartment_manager'),
      entityType: 'APARTMENT_ROLE',
      userId: manager.userId,
      apartmentId: site.siteId,
      role: 'apartment_manager',
      displayName: options.managerEmail,
      status: 'active',
      startDate: today,
      createdAt: ts,
      createdBy: ACTOR,
      updatedAt: ts,
      updatedBy: ACTOR,
      version: 1,
    };
    try {
      await deps.roles.create(record);
      roleCreated = true;
    } catch (err) {
      if (!(err instanceof DataAccessError && err.code === 'conflict')) throw err;
      deps.log('Yonetici rol kaydi zaten var; degistirilmedi');
    }

    // Ilk giriste dogrudan bu apartman secili gelsin.
    await deps.cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: options.managerEmail,
        UserAttributes: [
          { Name: 'custom:active_apartment', Value: site.siteId },
          { Name: 'custom:active_role', Value: 'apartment_manager' },
        ],
      }),
    );
  }
  deps.log(`apartment_manager hazir: ${options.managerEmail} -> ${site.name}`);
  result.manager = { email: options.managerEmail, ...manager, roleCreated };
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseCli(argv: string[], env: NodeJS.ProcessEnv): SeedOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      'admin-email': { type: 'string' },
      'manager-email': { type: 'string' },
      'apartment-id': { type: 'string' },
      'site-name': { type: 'string' },
      'site-type': { type: 'string', default: 'apartment' },
      city: { type: 'string' },
      district: { type: 'string' },
      address: { type: 'string' },
      'tenant-id': { type: 'string' },
      'user-pool-id': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  });

  const userPoolId = values['user-pool-id'] ?? env.COGNITO_USER_POOL_ID;
  if (!userPoolId) throw new Error('COGNITO_USER_POOL_ID (veya --user-pool-id) gerekli');

  let site: SeedOptions['site'];
  if (values['site-name']) {
    const missing = (['city', 'district', 'address'] as const).filter((k) => !values[k]);
    if (missing.length) throw new Error(`Yeni site icin eksik: ${missing.map((m) => `--${m}`).join(', ')}`);
    const type = values['site-type'];
    if (type !== 'apartment' && type !== 'site' && type !== 'residence') {
      throw new Error('--site-type apartment | site | residence olmalidir');
    }
    site = {
      name: values['site-name'],
      city: values.city as string,
      district: values.district as string,
      address: values.address as string,
      type,
    };
  }

  return {
    userPoolId,
    adminEmail: values['admin-email'],
    managerEmail: values['manager-email'],
    apartmentId: values['apartment-id'],
    site,
    tenantId: values['tenant-id'],
    dryRun: values['dry-run'],
  };
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2), process.env);
  if (!process.env.DYNAMODB_TABLE_NAME) throw new Error('DYNAMODB_TABLE_NAME gerekli');
  const core = createCoreService();
  const result = await seedAdmin(options, {
    cognito: new CognitoIdentityProviderClient({}),
    roles: apartmentRoleRepository,
    core: coreRepository,
    createSite: (actor, tenantId, input) => core.createSite(actor, tenantId, input),
    now: () => new Date(),
    log: (line) => console.log(`- ${line}`),
  });
  console.log(JSON.stringify({ dryRun: options.dryRun, ...result }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`HATA: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
