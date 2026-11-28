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
 * reservations | polls | assemblies | tenders`; yalnizca acikca secilenler saklanir, verilmeyen kategori ACIK
 * sayilir. Ana anahtar (`enabled`) kapaliysa hicbiri gitmez.
 *
 * Kayit duz ozniteliklerdir (`emailEnabled`, `ticketEmails` (O1-2 ile ayni ad), `emailFinance`,
 * `emailAnnouncements`, `emailGate`, `emailReservations`, `emailPolls`, `emailAssemblies`, `emailTenders`). Guncelleme
 * OKUMADAN yalnizca gonderilen alanlari `SET` eder (UpdateExpression): iki cihazin es zamanli kismi
 * guncellemesi birbirini ezmez; eski sekme yalnizca degistirdigi alani gonderdigi icin ana anahtari geri acamaz.
 *
 * Mobil bildirim (push, Expo): ayni yapi `push.enabled` + `push.<kategori>` (ana anahtar ve kategoriler
 * e-postadan BAGIMSIZ); oznitelikler `pushEnabled`, `pushFinance`, `pushAnnouncements`, `pushTickets`,
 * `pushGate`, `pushReservations`, `pushPolls`, `pushAssemblies`, `pushTenders`. Push ozniteligi olmayan
 * eski kayit: push ACIK. GET her zaman `push: { enabled, ... }` doner; PUT `email` ve/veya `push` alir.
 */

export type EmailCategoryPreferences = Partial<Record<NotificationCategory, boolean>>;

export type ChannelPreferences = { enabled: boolean } & EmailCategoryPreferences;

export type NotificationPreferences = {
  email: ChannelPreferences;
  /** Mobil bildirim (push); e-postadan bagimsiz. */
  push: ChannelPreferences;
  updatedAt?: string;
};

type ChannelInput = { enabled?: boolean } & EmailCategoryPreferences;

/** PUT govdesi / kismi guncelleme: yalnizca gonderilen alanlar degisir (`email` ve/veya `push`). */
export type PreferencesInput = { email?: ChannelInput; push?: ChannelInput };

export type PreferencesPatch = {
  enabled?: boolean;
  categories: EmailCategoryPreferences;
  /** Push kanali (verilmezse push alanlari yazilmaz). */
  push?: { enabled?: boolean; categories: EmailCategoryPreferences };
  updatedAt: string;
};

export const DEFAULT_PREFERENCES: NotificationPreferences = { email: { enabled: true }, push: { enabled: true } };

/** Kategori -> kayit ozniteligi (ariza icin O1-2'nin `ticketEmails` adi korunur). */
export const CATEGORY_ATTRIBUTES: Record<NotificationCategory, string> = {
  finance: 'emailFinance',
  announcements: 'emailAnnouncements',
  tickets: 'ticketEmails',
  gate: 'emailGate',
  reservations: 'emailReservations',
  polls: 'emailPolls',
  assemblies: 'emailAssemblies',
  tenders: 'emailTenders',
  billing: 'emailBilling',
};

/** Push kategori -> kayit ozniteligi. */
export const PUSH_CATEGORY_ATTRIBUTES: Record<NotificationCategory, string> = {
  finance: 'pushFinance',
  announcements: 'pushAnnouncements',
  tickets: 'pushTickets',
  gate: 'pushGate',
  reservations: 'pushReservations',
  polls: 'pushPolls',
  assemblies: 'pushAssemblies',
  tenders: 'pushTenders',
  billing: 'pushBilling',
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
        const pushStored = Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, item[PUSH_CATEGORY_ATTRIBUTES[c]]]));
        return {
          email: { enabled: item.emailEnabled !== false, ...categoriesOf(stored) },
          // Push ozniteligi olmayan (eski) kayit: push acik.
          push: { enabled: item.pushEnabled !== false, ...categoriesOf(pushStored) },
          ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
        };
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
      if (patch.push?.enabled !== undefined) set('pushEnabled', patch.push.enabled);
      const pushCategories = categoriesOf(patch.push?.categories);
      for (const c of NOTIFICATION_CATEGORIES) if (pushCategories[c] !== undefined) set(PUSH_CATEGORY_ATTRIBUTES[c], pushCategories[c] as boolean);
      // Kullanici geneli tercih: PLATFORM zincirine denetlenir (apartmandan bagimsiz).
      await auditedUpdate(
        preferenceKeys(userId),
        { UpdateExpression: `SET ${sets.join(', ')}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values },
        {
          action: 'notification_preferences.update',
          target: { type: 'user', id: userId },
          actorId: userId,
          details: {
            ...(patch.enabled === undefined ? {} : { emailEnabled: patch.enabled }),
            ...(Object.keys(categories).length ? { emailCategories: categories } : {}),
            ...(patch.push?.enabled === undefined ? {} : { pushEnabled: patch.push.enabled }),
            ...(Object.keys(pushCategories).length ? { pushCategories } : {}),
          },
        },
      );
    },
  };
}

/** Tek kanalin govdesi: `enabled?` + bilinen kategoriler, yalnizca boolean. */
function parseChannel(value: unknown, field: 'email' | 'push'): ChannelInput {
  const o = asObject(value, field);
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') throw new ValidationError(`${field}.enabled true veya false olmali`, `${field}.enabled`);
  const extra = Object.keys(o).filter((k) => k !== 'enabled' && !isNotificationCategory(k));
  if (extra.length) throw new ValidationError(`Bilinmeyen alan: ${field}.${extra[0]}`, `${field}.${extra[0]}`);
  for (const c of NOTIFICATION_CATEGORIES) {
    if (o[c] !== undefined && typeof o[c] !== 'boolean') throw new ValidationError(`${field}.${c} true veya false olmali`, `${field}.${c}`);
  }
  return { ...(o.enabled === undefined ? {} : { enabled: o.enabled as boolean }), ...categoriesOf(o) };
}

const isEmpty = (c: ChannelInput | undefined) => !c || Object.keys(c).length === 0;

/**
 * PUT govdesi: `{ email?: { enabled?, finance?, announcements?, tickets?, gate?, reservations?, polls?,
 * assemblies?, tenders?: boolean }, push?: { ...ayni alanlar } }`; toplamda en az bir alan zorunlu, bilinmeyen
 * alan reddedilir. Verilmeyen alan degismez (eski istemcinin yalnizca `email` gondermesi push'a dokunmaz).
 */
export function parsePreferences(body: unknown): PreferencesInput {
  const o = asObject(body);
  const extra = Object.keys(o).filter((k) => k !== 'email' && k !== 'push');
  if (extra.length) throw new ValidationError(`Bilinmeyen alan: ${extra.join(', ')}`, extra[0]);
  if (o.email === undefined && o.push === undefined) throw new ValidationError('email veya push tercihi gönderilmeli', 'email');
  const email = o.email === undefined ? undefined : parseChannel(o.email, 'email');
  const push = o.push === undefined ? undefined : parseChannel(o.push, 'push');
  if (isEmpty(email) && isEmpty(push)) throw new ValidationError('En az bir bildirim tercihi gönderilmeli', email ? 'email' : 'push');
  return { ...(isEmpty(email) ? {} : { email }), ...(isEmpty(push) ? {} : { push }) };
}

export function createPreferencesService(deps: { repository?: PreferencesRepository; now?: () => Date } = {}) {
  const repository = deps.repository ?? createDynamoPreferencesRepository();
  const now = deps.now ?? (() => new Date());
  return {
    get: (userId: string) => repository.get(userId),
    /** Yalnizca gonderilen alanlar yazilir (okumadan); yanit yazim sonrasi guncel tercihtir. */
    async update(userId: string, body: unknown): Promise<NotificationPreferences> {
      const parsed = parsePreferences(body);
      const { enabled, ...rest } = parsed.email ?? {};
      const push = parsed.push ? { ...(parsed.push.enabled === undefined ? {} : { enabled: parsed.push.enabled }), categories: categoriesOf(parsed.push) } : undefined;
      await repository.patch(userId, { ...(enabled === undefined ? {} : { enabled }), categories: categoriesOf(rest), ...(push ? { push } : {}), updatedAt: now().toISOString() });
      return repository.get(userId);
    },
  };
}

export type PreferencesService = ReturnType<typeof createPreferencesService>;
