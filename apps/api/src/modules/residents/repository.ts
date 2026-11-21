import { auditedPutNew, auditedPutVersioned } from '../audit/log.js';
import {
  getTenantItem,
  queryTenantAll,
  skKey,
  tenantPk,
} from '../../config/dynamodb.js';
import type { AuditFields, TableKeys } from '../core/types.js';

/**
 * Apartman bazli kisi kaydi: yonetici ekranlarinda ad/e-posta gostermek icin.
 *   PK = `APT#<apartmentId>`, SK = `PERSON#<userId>`
 *
 * Bilerek apartman bolumunde tutulur (kullanici geneli bir profil degil): ayni kisi iki
 * apartmanda farkli adla kayitli olabilir ve bir apartmanin yoneticisi digerinin
 * verisini goremez (tenant izolasyonu). Kimlik dogrulamanin kaynagi Cognito'dur.
 */
export type Person = TableKeys &
  AuditFields & {
    entityType: 'PERSON';
    apartmentId: string;
    /** Cognito `sub`. */
    userId: string;
    fullName: string;
    email: string;
    /**
     * E-posta dogrulama durumu. Davet akisi Cognito'da adresi dogrulanmis olarak olusturur;
     * alan yoksa dogrulanmis sayilir. `false` ise bildirim e-postasi gonderilmez.
     */
    emailVerified?: boolean;
  };

const PERSON_PREFIX = 'PERSON#';

export const personKeys = {
  person: (apartmentId: string, userId: string): TableKeys => ({
    PK: tenantPk(apartmentId),
    SK: skKey('PERSON', userId),
  }),
};

export type PersonRepository = {
  get(apartmentId: string, userId: string): Promise<Person | undefined>;
  list(apartmentId: string): Promise<Person[]>;
  create(person: Person): Promise<void>;
  update(person: Person, expectedVersion: number): Promise<void>;
};

export const personRepository: PersonRepository = {
  get: (apartmentId, userId) => getTenantItem<Person>(personKeys.person(apartmentId, userId)),
  list: (apartmentId) => queryTenantAll<Person>(apartmentId, PERSON_PREFIX, { ConsistentRead: true }),
  // Kisi kaydi (davet): denetimde ad / e-posta tutulmaz, yalnizca kimlik.
  create: (person) =>
    auditedPutNew(person, { apartmentId: person.apartmentId, action: 'person.create', target: { type: 'person', id: person.userId }, actorId: person.createdBy }),
  update: (person, expectedVersion) =>
    auditedPutVersioned(person, expectedVersion, {
      apartmentId: person.apartmentId,
      action: 'person.update',
      target: { type: 'person', id: person.userId },
      actorId: person.updatedBy,
      details: { version: person.version, emailVerified: person.emailVerified },
    }),
};
