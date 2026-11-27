import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { KEY_SEPARATOR, getDynamo, toDataAccessError } from '../../config/dynamodb.js';
import { auditedPut } from '../audit/log.js';
import { ValidationError, asObject } from '../core/validation.js';
import { NOTIFICATION_CATEGORIES, type NotificationCategory, isNotificationCategory } from './categories.js';

/**
 * Kullanici bildirim tercihleri (kullanici geneli; apartmandan bagimsiz).
 *
 *   PK = `USER#<userId>`, SK = `NOTIFPREF`
 *
 * Kayit yoksa varsayilan: e-posta bildirimleri ACIK. Tercih yalnizca kullanicinin kendisi
 * tarafindan (`/api/me/notification-preferences`, kimlik JWT'den) degistirilir; yonetici bir
 * sakinin tercihini degistiremez. Kisisel veri tasimaz (yalnizca acik/kapali + zaman damgasi).
 *
 * Kategori bazli e-posta (bkz. `categories.ts`): `email.finance | announcements | tickets | gate |
 * reservations | polls`; yalnizca acikca secilenler saklanir, verilmeyen kategori ACIK sayilir. Ana
 * anahtar (`enabled`) kapaliysa hicbiri gitmez. Kayit: `emailCategories` haritasi; O1-2'nin
 * `ticketEmails` alani `tickets` icin geriye donuk okunur.
 */

export type EmailCategoryPreferences = Partial<Record<NotificationCategory, boolean>>;

export type NotificationPreferences = {
  email: { enabled: boolean } & EmailCategoryPreferences;
  updatedAt?: string;
};

export const DEFAULT_PREFERENCES: NotificationPreferences = { email: { enabled: true } };

type StoredPreferences = {
  PK: string;
  SK: 'NOTIFPREF';
  entityType: 'NOTIFICATION_PREFERENCES';
  userId: string;
  emailEnabled: boolean;
  /** Acikca secilen kategoriler (yalnizca false / true verilenler). */
  emailCategories?: EmailCategoryPreferences;
  /** O1-2 (eski kayit): ariza e-postalari; `emailCategories.tickets` yoksa okunur. */
  ticketEmails?: boolean;
  updatedAt: string;
};

/** Yalnizca bilinen kategoriler, yalnizca boolean degerler (sira sabit). */
function categoriesOf(source: Record<string, unknown> | undefined): EmailCategoryPreferences {
  const out: EmailCategoryPreferences = {};
  for (const c of NOTIFICATION_CATEGORIES) if (typeof source?.[c] === 'boolean') out[c] = source[c] as boolean;
  return out;
}

const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const preferenceKeys = (userId: string) => {
  if (!USER_ID.test(userId)) throw new Error('Gecersiz userId');
  return { PK: `USER${KEY_SEPARATOR}${userId}`, SK: 'NOTIFPREF' as const };
};

export type PreferencesRepository = {
  get(userId: string): Promise<NotificationPreferences>;
  put(userId: string, prefs: NotificationPreferences): Promise<void>;
};

export function createDynamoPreferencesRepository(): PreferencesRepository {
  return {
    async get(userId) {
      const key = preferenceKeys(userId); // gecersiz kimlik programlama hatasidir: sarmalanmaz
      const { client, tableName } = getDynamo();
      try {
        const out = await client.send(new GetCommand({ TableName: tableName, Key: key }));
        const item = out.Item as StoredPreferences | undefined;
        if (!item) return structuredClone(DEFAULT_PREFERENCES);
        const legacy = typeof item.ticketEmails === 'boolean' ? { tickets: item.ticketEmails } : {};
        return { email: { enabled: item.emailEnabled !== false, ...categoriesOf({ ...legacy, ...(item.emailCategories ?? {}) }) }, updatedAt: item.updatedAt };
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    async put(userId, prefs) {
      const categories = categoriesOf(prefs.email);
      const explicit = Object.keys(categories).length > 0;
      const item: StoredPreferences = {
        ...preferenceKeys(userId),
        entityType: 'NOTIFICATION_PREFERENCES',
        userId,
        emailEnabled: prefs.email.enabled,
        ...(explicit ? { emailCategories: categories } : {}),
        updatedAt: prefs.updatedAt ?? new Date().toISOString(),
      };
      // Kullanici geneli tercih: PLATFORM zincirine denetlenir (apartmandan bagimsiz).
      await auditedPut(item, {
        action: 'notification_preferences.update',
        target: { type: 'user', id: userId },
        actorId: userId,
        details: { emailEnabled: prefs.email.enabled, ...(explicit ? { emailCategories: categories } : {}) },
      });
    },
  };
}

/**
 * PUT govdesi: `{ email: { enabled: boolean, finance?, announcements?, tickets?, gate?, reservations?,
 * polls?: boolean } }` (bilinmeyen alan reddedilir).
 */
export function parsePreferences(body: unknown): NotificationPreferences {
  const o = asObject(body);
  const extra = Object.keys(o).filter((k) => k !== 'email');
  if (extra.length) throw new ValidationError(`Bilinmeyen alan: ${extra.join(', ')}`, extra[0]);
  const email = asObject(o.email, 'email');
  if (typeof email.enabled !== 'boolean') throw new ValidationError('email.enabled true veya false olmali', 'email.enabled');
  const extraEmail = Object.keys(email).filter((k) => k !== 'enabled' && !isNotificationCategory(k));
  if (extraEmail.length) throw new ValidationError(`Bilinmeyen alan: email.${extraEmail[0]}`, `email.${extraEmail[0]}`);
  for (const c of NOTIFICATION_CATEGORIES) {
    if (email[c] !== undefined && typeof email[c] !== 'boolean') throw new ValidationError(`email.${c} true veya false olmali`, `email.${c}`);
  }
  return { email: { enabled: email.enabled, ...categoriesOf(email) } };
}

export function createPreferencesService(deps: { repository?: PreferencesRepository; now?: () => Date } = {}) {
  const repository = deps.repository ?? createDynamoPreferencesRepository();
  const now = deps.now ?? (() => new Date());
  return {
    get: (userId: string) => repository.get(userId),
    async update(userId: string, body: unknown): Promise<NotificationPreferences> {
      const parsed = parsePreferences(body);
      // Verilmeyen kategoride onceki secim korunur (ekran tek kategoriyi gonderebilir; eski
      // istemciler kategori gondermez).
      const current = await repository.get(userId);
      const prefs: NotificationPreferences = {
        email: { enabled: parsed.email.enabled, ...categoriesOf(current.email), ...categoriesOf(parsed.email) },
        updatedAt: now().toISOString(),
      };
      await repository.put(userId, prefs);
      return prefs;
    },
  };
}

export type PreferencesService = ReturnType<typeof createPreferencesService>;
