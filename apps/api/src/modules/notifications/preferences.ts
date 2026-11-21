import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { KEY_SEPARATOR, getDynamo, toDataAccessError } from '../../config/dynamodb.js';
import { auditedPut } from '../audit/log.js';
import { ValidationError, asObject } from '../core/validation.js';

/**
 * Kullanici bildirim tercihleri (kullanici geneli; apartmandan bagimsiz).
 *
 *   PK = `USER#<userId>`, SK = `NOTIFPREF`
 *
 * Kayit yoksa varsayilan: e-posta bildirimleri ACIK. Tercih yalnizca kullanicinin kendisi
 * tarafindan (`/api/me/notification-preferences`, kimlik JWT'den) degistirilir; yonetici bir
 * sakinin tercihini degistiremez. Kisisel veri tasimaz (yalnizca acik/kapali + zaman damgasi).
 */

export type NotificationPreferences = {
  email: { enabled: boolean };
  updatedAt?: string;
};

export const DEFAULT_PREFERENCES: NotificationPreferences = { email: { enabled: true } };

type StoredPreferences = {
  PK: string;
  SK: 'NOTIFPREF';
  entityType: 'NOTIFICATION_PREFERENCES';
  userId: string;
  emailEnabled: boolean;
  updatedAt: string;
};

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
        return { email: { enabled: item.emailEnabled !== false }, updatedAt: item.updatedAt };
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    async put(userId, prefs) {
      const item: StoredPreferences = {
        ...preferenceKeys(userId),
        entityType: 'NOTIFICATION_PREFERENCES',
        userId,
        emailEnabled: prefs.email.enabled,
        updatedAt: prefs.updatedAt ?? new Date().toISOString(),
      };
      // Kullanici geneli tercih: PLATFORM zincirine denetlenir (apartmandan bagimsiz).
      await auditedPut(item, {
        action: 'notification_preferences.update',
        target: { type: 'user', id: userId },
        actorId: userId,
        details: { emailEnabled: prefs.email.enabled },
      });
    },
  };
}

/** PUT govdesi: `{ email: { enabled: boolean } }` (bilinmeyen alan reddedilir). */
export function parsePreferences(body: unknown): NotificationPreferences {
  const o = asObject(body);
  const extra = Object.keys(o).filter((k) => k !== 'email');
  if (extra.length) throw new ValidationError(`Bilinmeyen alan: ${extra.join(', ')}`, extra[0]);
  const email = asObject(o.email, 'email');
  if (typeof email.enabled !== 'boolean') throw new ValidationError('email.enabled true veya false olmali', 'email.enabled');
  return { email: { enabled: email.enabled } };
}

export function createPreferencesService(deps: { repository?: PreferencesRepository; now?: () => Date } = {}) {
  const repository = deps.repository ?? createDynamoPreferencesRepository();
  const now = deps.now ?? (() => new Date());
  return {
    get: (userId: string) => repository.get(userId),
    async update(userId: string, body: unknown): Promise<NotificationPreferences> {
      const prefs = { ...parsePreferences(body), updatedAt: now().toISOString() };
      await repository.put(userId, prefs);
      return prefs;
    },
  };
}

export type PreferencesService = ReturnType<typeof createPreferencesService>;
