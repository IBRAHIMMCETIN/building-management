import type { Role } from '../../auth/claims.js';
import { DataAccessError } from '../../config/dynamodb.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import { CoreError } from '../core/service.js';
import type { IsoDate } from '../core/types.js';
import { ValidationError, asObject, assertId, reqString } from '../core/validation.js';
import { type MembershipService, type MembershipView, createMembershipService } from '../memberships/service.js';
import { type UserDirectory, DirectoryUnavailableError, createDirectoryFromEnv } from './directory.js';
import { type Person, type PersonRepository, personKeys, personRepository } from './repository.js';

/**
 * Sakin daveti ve kisi listesi.
 *
 * Davet akisi (`invite`):
 *  1. Girdi ve daire dogrulanir (Cognito'ya dokunmadan once: gecersiz istek kullanici olusturmaz).
 *  2. E-postaya ait Cognito kullanicisi bulunur ya da olusturulur (gecici sifre e-postasi).
 *  3. Uyelik, memberships servisinin TUM kurallariyla olusturulur (cakisma, hisse, tarih).
 *  4. Kisi kaydi (ad/e-posta) apartman bolumune yazilir.
 * 3. adim reddedilirse (ornegin daireye zaten kiraci atanmis) Cognito kullanicisi kalir ama
 * hicbir yetkisi olmaz; ayni e-postayla yeniden davet onu yeniden kullanir.
 */

export type ResidentsErrorCode = 'invitations_disabled' | 'rate_limited' | 'invalid_email';

export class ResidentsError extends Error {
  readonly code: ResidentsErrorCode;
  readonly httpStatus: 400 | 429 | 503;

  constructor(code: ResidentsErrorCode, message: string) {
    super(message);
    this.name = 'ResidentsError';
    this.code = code;
    this.httpStatus = code === 'invalid_email' ? 400 : code === 'rate_limited' ? 429 : 503;
  }
}

export type ResidentsContext = { apartmentId: string; userId: string; role: Role };

export type PersonView = Pick<Person, 'userId' | 'fullName' | 'email' | 'createdAt' | 'updatedAt'>;

export type InviteResult = {
  person: PersonView;
  membership: MembershipView;
  /** sent: yeni hesap, gecici sifre e-postasi gitti. existing_user: hesap zaten vardi. */
  invitation: 'sent' | 'existing_user';
};

export type ResidentsServiceDeps = {
  people: PersonRepository;
  core: Pick<CoreRepository, 'getUnit'>;
  memberships: Pick<MembershipService, 'create'>;
  directory: UserDirectory;
  now: () => Date;
};

export type ResidentsService = ReturnType<typeof createResidentsService>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Denetci (observer) kisilerin e-postasini maskeli gorur: ayse@site.com -> a***@site.com */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

function cognitoErrorToResidents(err: unknown): unknown {
  if (err instanceof DirectoryUnavailableError) {
    return new ResidentsError('invitations_disabled', 'Davet servisi bu ortamda yapilandirilmamis');
  }
  const name = err instanceof Error ? err.name : '';
  if (name === 'InvalidParameterException') {
    return new ResidentsError('invalid_email', 'E-posta adresi kabul edilmedi');
  }
  if (name === 'LimitExceededException' || name === 'TooManyRequestsException') {
    return new ResidentsError('rate_limited', 'Cok fazla davet gonderildi, biraz sonra tekrar deneyin');
  }
  return err;
}

export function createResidentsService(overrides: Partial<ResidentsServiceDeps> = {}) {
  const deps: ResidentsServiceDeps = {
    people: personRepository,
    core: coreRepository,
    memberships: overrides.memberships ?? createMembershipService(),
    directory: overrides.directory ?? createDirectoryFromEnv(),
    now: () => new Date(),
    ...overrides,
  };

  const today = (): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());

  const toView = (p: Person, role: Role): PersonView => ({
    userId: p.userId,
    fullName: p.fullName,
    email: role === 'observer' ? maskEmail(p.email) : p.email,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  });

  async function upsertPerson(ctx: ResidentsContext, userId: string, fullName: string, email: string): Promise<Person> {
    const ts = deps.now().toISOString();
    const existing = await deps.people.get(ctx.apartmentId, userId);
    if (!existing) {
      const person: Person = {
        ...personKeys.person(ctx.apartmentId, userId),
        entityType: 'PERSON',
        apartmentId: ctx.apartmentId,
        userId,
        fullName,
        email,
        createdAt: ts,
        createdBy: ctx.userId,
        updatedAt: ts,
        updatedBy: ctx.userId,
        version: 1,
      };
      try {
        await deps.people.create(person);
        return person;
      } catch (err) {
        // Es zamanli davet kaydi once yazdiysa onu kullan.
        if (err instanceof DataAccessError && err.code === 'conflict') {
          const raced = await deps.people.get(ctx.apartmentId, userId);
          if (raced) return raced;
        }
        throw err;
      }
    }
    if (existing.fullName === fullName && existing.email === email) return existing;
    // Yoneticinin son girdigi ad esas alinir (ornegin yazim duzeltmesi).
    const updated: Person = {
      ...existing,
      fullName,
      email,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: existing.version + 1,
    };
    await deps.people.update(updated, existing.version);
    return updated;
  }

  async function invite(ctx: ResidentsContext, body: unknown): Promise<InviteResult> {
    const o = asObject(body);
    const unitId = assertId(o.unitId, 'unitId');
    const fullName = reqString(o, 'fullName', 100, 2).replace(/\s+/g, ' ');
    const email = reqString(o, 'email', 254, 3).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new ValidationError('email gecerli bir e-posta adresi olmalidir', 'email');

    const unit = await deps.core.getUnit(ctx.apartmentId, unitId);
    if (!unit || unit.status !== 'active') throw new CoreError('not_found', 'Bagimsiz bolum bulunamadi veya pasif');

    let account: { userId: string; created: boolean };
    try {
      account = await deps.directory.findOrCreate({ email, fullName });
    } catch (err) {
      throw cognitoErrorToResidents(err);
    }

    // Uyelik kurallari tek yerde: memberships servisi. Davet yalnizca userId'yi saglar.
    const { email: _e, fullName: _f, ...membershipInput } = o;
    const membership = await deps.memberships.create(
      { apartmentId: ctx.apartmentId, userId: ctx.userId },
      { ...membershipInput, userId: account.userId, startDate: o.startDate ?? today() },
    );

    const person = await upsertPerson(ctx, account.userId, fullName, email);
    return {
      person: toView(person, ctx.role),
      membership,
      invitation: account.created ? 'sent' : 'existing_user',
    };
  }

  async function list(ctx: ResidentsContext): Promise<PersonView[]> {
    const people = await deps.people.list(ctx.apartmentId);
    return people
      .filter((p) => p.apartmentId === ctx.apartmentId)
      .map((p) => toView(p, ctx.role))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'tr'));
  }

  return { invite, list };
}
