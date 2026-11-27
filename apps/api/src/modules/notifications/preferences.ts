import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { KEY_SEPARATOR, getDynamo, toDataAccessError } from '../../config/dynamodb.js';
import { auditedUpdate } from '../audit/log.js';
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
 * anahtar (`enabled`) kapaliysa hicbiri gitmez.
 *
 * Kayit duz ozniteliklerdir (`emailEnabled`, `ticketEmails` (O1-2 ile ayni ad), `emailFinance`,
 * `emailAnnouncements`, `emailGate`, `emailReservations`, `emailPolls`). Guncelleme OKUMADAN yalnizca
 * gonderilen alanlari `SET` eder (UpdateExpression): iki cihazin es zamanli kismi guncellemesi
 * birbirini ezmez; eski sekme yalnizca degistirdigi alani gonderdigi icin ana anahtari geri acamaz.
 */

export type EmailCategoryPreferences = Partial<Record<NotificationCategory, boolean>>;

export type NotificationPreferences = {
  email: { enabled: boolean } & EmailCategoryPreferences;
  updatedAt?: string;
};

/** PUT govdesi / kismi guncelleme: yalnizca gonderilen alanlar degisir. */
export type PreferencesInput = { email: { enabled?: boolean } & EmailCategoryPreferences };

export type PreferencesPatch = { enabled?: boolean; categories: EmailCategoryPreferences; updatedAt: string };

export const DEFAULT_PREFERENCES: NotificationPreferences = { email: { enabled: true } };

/** Kategori -> kayit ozniteligi (ariza icin O1-2'nin `ticketEmails` adi korunur). */
export const CATEGORY_ATTRIBUTES: Record<NotificationCategory, string> = {
  finance: 'emailFinance',
  announcements: 'emailAnnouncements',
  tickets: 'ticketEmails',
  gate: 'emailGate',
  reservations: 'emailReservations',
  polls: 'emailPolls',
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
  /** Yalnizca verilen alanlari atomik olarak yazar (okumadan; diger alanlar oldugu gibi kalir). */
  patch(userId: string, patch: PreferencesPatch): Promise<void>;
};

export function createDynamoPreferencesRepository(): PreferencesRepository {
  return {
    async get(userId) {
      const key = preferenceKeys(userId); // gecersiz kimlik programlama hatasidir: sarmalanmaz
      const { client, tableName } = getDynamo();
      try {
        // Tutarli okuma: PUT yaniti yazimin hemen ardindan bu okumadan uretilir.
        const out = await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }));
        const item = out.Item as Record<string, unknown> | undefined;
        if (!item) return structuredClone(DEFAULT_PREFERENCES);
        const stored = Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, item[CATEGORY_ATTRIBUTES[c]]]));
        return { email: { enabled: item.emailEnabled !== false, ...categoriesOf(stored) }, ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}) };
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    async patch(userId, patch) {
      const names: Record<string, string> = { '#et': 'entityType', '#uid': 'userId', '#upd': 'updatedAt' };
      const values: Record<string, unknown> = { ':et': 'NOTIFICATION_PREFERENCES', ':uid': userId, ':upd': patch.updatedAt };
      const sets = ['#et = :et', '#uid = :uid', '#upd = :upd'];
      const set = (name: string, value: boolean) => {
        const i = sets.length;
        names[`#a${i}`] = name;
        values[`:v${i}`] = value;
        sets.push(`#a${i} = :v${i}`);
      };
      if (patch.enabled !== undefined) set('emailEnabled', patch.enabled);
      const categories = categoriesOf(patch.categories);
      for (const c of NOTIFICATION_CATEGORIES) if (categories[c] !== undefined) set(CATEGORY_ATTRIBUTES[c], categories[c] as boolean);
      // Kullanici geneli tercih: PLATFORM zincirine denetlenir (apartmandan bagimsiz).
      await auditedUpdate(
        preferenceKeys(userId),
        { UpdateExpression: `SET ${sets.join(', ')}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values },
        {
          action: 'notification_preferences.update',
          target: { type: 'user', id: userId },
          actorId: userId,
          details: { ...(patch.enabled === undefined ? {} : { emailEnabled: patch.enabled }), ...(Object.keys(categories).length ? { emailCategories: categories } : {}) },
        },
      );
    },
  };
}

/**
 * PUT govdesi: `{ email: { enabled?, finance?, announcements?, tickets?, gate?, reservations?, polls?:
 * boolean } }`; en az bir alan zorunlu, bilinmeyen alan reddedilir. Verilmeyen alan degismez.
 */
export function parsePreferences(body: unknown): PreferencesInput {
  const o = asObject(body);
  const extra = Object.keys(o).filter((k) => k !== 'email');
  if (extra.length) throw new ValidationError(`Bilinmeyen alan: ${extra.join(', ')}`, extra[0]);
  const email = asObject(o.email, 'email');
  if (email.enabled !== undefined && typeof email.enabled !== 'boolean') throw new ValidationError('email.enabled true veya false olmali', 'email.enabled');
  const extraEmail = Object.keys(email).filter((k) => k !== 'enabled' && !isNotificationCategory(k));
  if (extraEmail.length) throw new ValidationError(`Bilinmeyen alan: email.${extraEmail[0]}`, `email.${extraEmail[0]}`);
  for (const c of NOTIFICATION_CATEGORIES) {
    if (email[c] !== undefined && typeof email[c] !== 'boolean') throw new ValidationError(`email.${c} true veya false olmali`, `email.${c}`);
  }
  const categories = categoriesOf(email);
  if (email.enabled === undefined && Object.keys(categories).length === 0) throw new ValidationError('En az bir bildirim tercihi gönderilmeli', 'email');
  return { email: { ...(email.enabled === undefined ? {} : { enabled: email.enabled }), ...categories } };
}

export function createPreferencesService(deps: { repository?: PreferencesRepository; now?: () => Date } = {}) {
  const repository = deps.repository ?? createDynamoPreferencesRepository();
  const now = deps.now ?? (() => new Date());
  return {
    get: (userId: string) => repository.get(userId),
    /** Yalnizca gonderilen alanlar yazilir (okumadan); yanit yazim sonrasi guncel tercihtir. */
    async update(userId: string, body: unknown): Promise<NotificationPreferences> {
      const parsed = parsePreferences(body);
      const { enabled, ...rest } = parsed.email;
      await repository.patch(userId, { ...(enabled === undefined ? {} : { enabled }), categories: categoriesOf(rest), updatedAt: now().toISOString() });
      return repository.get(userId);
    },
  };
}

export type PreferencesService = ReturnType<typeof createPreferencesService>;
