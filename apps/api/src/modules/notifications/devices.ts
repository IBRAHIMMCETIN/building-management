import { createHash } from 'node:crypto';
import { GetCommand, QueryCommand, type TransactWriteCommandInput, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DataAccessError, KEY_SEPARATOR, getDynamo, toDataAccessError } from '../../config/dynamodb.js';
import { type AuditDraft, sendWithAudit } from '../audit/log.js';
import { ValidationError, asObject } from '../core/validation.js';

/**
 * Mobil push cihaz kaydi (Expo push token). Kullanici geneli; apartmandan bagimsiz (kimlik JWT `sub`).
 *
 *   PK = `USER#<userId>`,         SK = `PUSHDEV#<deviceId>`   cihaz (status: active | inactive)
 *   PK = `PUSHTOKEN#<deviceId>`,  SK = `OWNER`                token'in guncel sahibi (ortak telefon)
 *   PK = `USER#<userId>`,         SK = `PUSHRATE#<gun>`       gunluk kayit sayaci (2 gun TTL)
 *
 * `deviceId` = sha256(token) ilk 32 hex: token anahtara yalnizca ozet olarak girer; ham token cihaz
 * kaydinin `token` ozniteligindedir ve YALNIZCA worker yolu (`listActiveForPush`) okur. API okumalari
 * `ProjectionExpression` ile token'i hic cekmez; yanitlarda ve denetim ayrintisinda token yoktur.
 * Pasife alinan kayittan ham token silinir (`REMOVE token`); silme yetkisi yoktur, durum kullanilir.
 *
 * Kurallar:
 *  - Ayni token ayni kullaniciyla yeniden kaydedilirse kayit tazelenir (`lastSeenAt`, surum, dil).
 *  - Ayni token baska kullaniciyla kaydedilirse (ortak telefon, hesap degisimi) cihaz yeni kullaniciya
 *    gecer: eski sahibin kaydi `moved` ile pasife alinir, sahiplik kaydi guncellenir (tek atomik yazim).
 *  - Tazeleme kosulludur: sahiplik kaydi hala bu kullaniciyi gostermeli ve cihaz aktif olmali (arada
 *    tasinan / kaldirilan cihaz dirilmez; catismada yeniden okunur). Worker ayrica sahiplik kaydi alicisini
 *    gostermeyen cihaza gondermez.
 *  - Kullanici basina en fazla `MAX_ACTIVE_DEVICES` aktif cihaz: asilirsa en eski gorulen pasife alinir.
 *  - Yeni / yeniden etkinlesen / tasinan kayit gunde en fazla `MAX_REGISTRATIONS_PER_DAY` (429).
 *  - Pasif cihaz ve sahibi pasif kalan sahiplik kaydi 90 gun sonra TTL ile duser (sinirsiz buyume yok).
 *  - Denetim (PLATFORM zinciri): gunun ilk yeni kaydi, her baska kullanicidan tasima ve kullanicinin
 *    kaldirmasi (bkz. `register`). Tazeleme denetlenmez. Ayrintida token yok (platform, cihaz kimligi).
 */

export const PUSH_PLATFORMS = ['ios', 'android'] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];
export const MAX_ACTIVE_DEVICES = 10;
/** Gunluk yeni / yeniden etkinlesen / tasinan kayit siniri (kullanici basina). */
export const MAX_REGISTRATIONS_PER_DAY = 20;
/** Pasif cihaz ve sahiplik kaydinin TTL'i. */
export const INACTIVE_TTL_SECONDS = 90 * 24 * 3600;

/** `foreign_project`: token yapilandirilan Expo projesine (EXPO_PROJECT_ID) ait degil. */
export type DeactivationReason = 'user' | 'moved' | 'limit' | 'device_not_registered' | 'foreign_project';

export type PushDevice = {
  deviceId: string;
  userId: string;
  platform: PushPlatform;
  appVersion?: string;
  locale?: string;
  status: 'active' | 'inactive';
  createdAt: string;
  lastSeenAt: string;
  deactivatedAt?: string;
  deactivationReason?: DeactivationReason;
};

/** Worker yolu: gonderim icin ham token dahil. */
export type PushTarget = Pick<PushDevice, 'deviceId' | 'userId' | 'platform' | 'lastSeenAt'> & { token: string };

/** Istemciye donen gorunum (token ve anahtarlar yok). */
export type PushDeviceView = Omit<PushDevice, 'userId'>;

export type DeviceInput = { token: string; platform: PushPlatform; appVersion?: string; locale?: string };

const EXPO_TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{8,200}\]$/;
const APP_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/;
const LOCALE = /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8}){0,3}$/;
const DEVICE_ID = /^[0-9a-f]{32}$/;
const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const isExpoPushToken = (value: unknown): value is string => typeof value === 'string' && EXPO_TOKEN.test(value);
export const isDeviceId = (value: unknown): value is string => typeof value === 'string' && DEVICE_ID.test(value);

/** Token ozeti (cihaz kimligi): anahtarlarda ham token yerine kullanilir. */
export const deviceIdOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 32);

const userPk = (userId: string) => {
  if (!USER_ID.test(userId)) throw new Error('Gecersiz userId');
  return `USER${KEY_SEPARATOR}${userId}`;
};

export const deviceKeys = {
  device: (userId: string, deviceId: string) => {
    if (!DEVICE_ID.test(deviceId)) throw new Error('Gecersiz deviceId');
    return { PK: userPk(userId), SK: `PUSHDEV${KEY_SEPARATOR}${deviceId}` };
  },
  owner: (deviceId: string) => {
    if (!DEVICE_ID.test(deviceId)) throw new Error('Gecersiz deviceId');
    return { PK: `PUSHTOKEN${KEY_SEPARATOR}${deviceId}`, SK: 'OWNER' as const };
  },
  /** Gunluk kayit sayaci (`day` = YYYY-MM-DD, Istanbul). */
  rate: (userId: string, day: string) => ({ PK: userPk(userId), SK: `PUSHRATE${KEY_SEPARATOR}${day}` }),
  userPrefix: 'PUSHDEV#',
};

/** POST govdesi: `{ token, platform: ios|android, appVersion?, locale? }`; bilinmeyen alan reddedilir. */
export function parseDeviceInput(body: unknown): DeviceInput {
  const o = asObject(body);
  const extra = Object.keys(o).filter((k) => !['token', 'platform', 'appVersion', 'locale'].includes(k));
  if (extra.length) throw new ValidationError(`Bilinmeyen alan: ${extra.join(', ')}`, extra[0]);
  if (!isExpoPushToken(o.token)) throw new ValidationError('token Expo push token biciminde olmali (ExponentPushToken[...])', 'token');
  if (typeof o.platform !== 'string' || !(PUSH_PLATFORMS as readonly string[]).includes(o.platform)) {
    throw new ValidationError('platform ios veya android olmali', 'platform');
  }
  if (o.appVersion !== undefined && (typeof o.appVersion !== 'string' || !APP_VERSION.test(o.appVersion))) {
    throw new ValidationError('appVersion en fazla 32 karakterlik surum olmali (ornegin 1.2.0)', 'appVersion');
  }
  if (o.locale !== undefined && (typeof o.locale !== 'string' || !LOCALE.test(o.locale))) {
    throw new ValidationError('locale dil etiketi olmali (ornegin tr-TR)', 'locale');
  }
  return {
    token: o.token,
    platform: o.platform as PushPlatform,
    ...(o.appVersion === undefined ? {} : { appVersion: o.appVersion as string }),
    ...(o.locale === undefined ? {} : { locale: o.locale as string }),
  };
}

// ---------------------------------------------------------------------------
// Depo
// ---------------------------------------------------------------------------

/** Kayit yazimi (tek atomik islem). */
export type DeviceWrite = {
  device: PushDevice & { token: string };
  /**
   * Sahiplik kaydi: okundugu andaki sahip (`null`: kayit yoktu). Bu kullaniciysa kosul olarak kalir
   * (yazim sirasinda hala bu kullaniciyi gostermeli; varsa `ttl` silinir), degilse yeni sahip yazilir.
   * Farkliysa tum yazim iptal: `DeviceWriteConflict`.
   */
  owner: { expected: string | null };
  /** Yalnizca tazeleme: cihaz kaydi yazim aninda hala AKTIF olmali (tasinmis / kaldirilmis cihaz dirilmez). */
  refresh?: boolean;
  /** Token baska kullanicidan tasiniyor: eski sahibin AKTIF kaydi pasife alinir. */
  moveFrom?: string;
  /** Sinir asimi: pasife alinacak (bu kullanicinin) aktif cihazlar. */
  evict: string[];
  audit?: AuditDraft;
};

export type DeactivateOptions = {
  audit?: AuditDraft;
  /** Yalnizca cihaz bu andan once goruldiyse (makbuz kontrolu: sonradan yeniden kaydedilen cihaz kalir). */
  seenBefore?: string;
};

export type DeviceRepository = {
  /** Kullanicinin tum cihaz kayitlari (token OKUNMAZ). */
  listByUser(userId: string): Promise<PushDevice[]>;
  get(userId: string, deviceId: string): Promise<PushDevice | undefined>;
  getOwner(deviceId: string): Promise<string | undefined>;
  save(write: DeviceWrite): Promise<void>;
  /**
   * Pasife alir, ham token'i siler, kayda (ve hala bu kullaniciyi gosteriyorsa sahiplik kaydina) 90 gun
   * `ttl` koyar; kayit yoksa / zaten pasifse / `seenBefore` tutmazsa `false`.
   */
  deactivate(userId: string, deviceId: string, reason: DeactivationReason, at: string, options?: DeactivateOptions): Promise<boolean>;
  /**
   * Worker yolu: aktif cihazlar ham token ile, en son gorulen once, en fazla `MAX_ACTIVE_DEVICES`.
   * Sahiplik kaydi bu kullaniciyi gostermeyen cihaz atlanir (tasinma yarisina karsi ikinci savunma).
   */
  listActiveForPush(userId: string): Promise<PushTarget[]>;
  /**
   * Gunluk kayit sayaci (yeni / yeniden etkinlesen / tasinan kayit): artirir ve yeni degeri dondurur;
   * sinir asildiysa `DeviceRateLimitError`.
   */
  countRegistration(userId: string, day: string, at: Date): Promise<number>;
};

/** API okumalarinin projeksiyonu: `token` bilerek yok. */
const VIEW_FIELDS = ['deviceId', 'userId', 'platform', 'appVersion', 'locale', '#st', 'createdAt', 'lastSeenAt', 'deactivatedAt', 'deactivationReason'];

const toDevice = (item: Record<string, unknown>): PushDevice => {
  const { PK: _pk, SK: _sk, entityType: _e, token: _t, updatedAt: _u, ttl: _ttl, ...rest } = item;
  return rest as PushDevice;
};

const ttlAfter = (at: string, seconds: number) => Math.floor(Date.parse(at) / 1000) + seconds;

const deactivateUpdate = (key: { PK: string; SK: string }, reason: DeactivationReason, at: string, tableName: string, requireActive: boolean, seenBefore?: string) => ({
  Update: {
    TableName: tableName,
    Key: key,
    UpdateExpression: 'SET #st = :inactive, deactivatedAt = :at, deactivationReason = :reason, updatedAt = :at, #ttl = :ttl REMOVE #tok',
    ConditionExpression: [requireActive ? 'attribute_exists(PK) AND #st = :active' : 'attribute_exists(PK)', ...(seenBefore ? ['lastSeenAt < :seen'] : [])].join(' AND '),
    ExpressionAttributeNames: { '#st': 'status', '#tok': 'token', '#ttl': 'ttl' },
    ExpressionAttributeValues: {
      ':inactive': 'inactive',
      ':at': at,
      ':reason': reason,
      ':ttl': ttlAfter(at, INACTIVE_TTL_SECONDS),
      ...(requireActive ? { ':active': 'active' } : {}),
      ...(seenBefore ? { ':seen': seenBefore } : {}),
    },
  },
});

/** Kosul / cakisma kaynakli iptal: cagiran yeniden okuyup tekrar dener. */
export class DeviceWriteConflict extends DataAccessError {
  constructor(cause?: unknown) {
    super('conflict', 'Cihaz kaydi ayni anda degisti; tekrar deneyin', { cause });
    this.name = 'DeviceWriteConflict';
  }
}

/** Gunluk kayit siniri asildi (`429`). */
export class DeviceRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`Bugün en fazla ${MAX_REGISTRATIONS_PER_DAY} cihaz kaydı yapılabilir; yarın tekrar deneyin.`);
    this.name = 'DeviceRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const isConditionFailure = (err: unknown) =>
  err instanceof ConditionalCheckFailedException || (err instanceof TransactionCanceledException && err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed');

export function createDynamoDeviceRepository(): DeviceRepository {
  const query = async (userId: string, projection?: string[]) => {
    const PK = userPk(userId);
    const { client, tableName } = getDynamo();
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    try {
      do {
        const out = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
            ExpressionAttributeValues: { ':pk': PK, ':sk': deviceKeys.userPrefix },
            ...(projection ? { ProjectionExpression: projection.join(', '), ExpressionAttributeNames: { '#st': 'status', ...(projection.includes('#tok') ? { '#tok': 'token' } : {}) } } : {}),
            ConsistentRead: true,
            ...(start ? { ExclusiveStartKey: start } : {}),
          }),
        );
        items.push(...((out.Items ?? []) as Record<string, unknown>[]));
        start = out.LastEvaluatedKey;
      } while (start);
    } catch (err) {
      throw toDataAccessError(err);
    }
    return items;
  };

  async function getOwner(deviceId: string): Promise<string | undefined> {
    const { client, tableName } = getDynamo();
    try {
      const out = await client.send(new GetCommand({ TableName: tableName, Key: deviceKeys.owner(deviceId), ConsistentRead: true }));
      return typeof out.Item?.userId === 'string' ? out.Item.userId : undefined;
    } catch (err) {
      throw toDataAccessError(err);
    }
  }

  /** Sahiplik kaydi hala bu kullaniciyi gosteriyorsa 90 gun sonra dusmesi icin `ttl` (en iyi caba). */
  async function expireOwner(userId: string, deviceId: string, at: string): Promise<void> {
    const { client, tableName } = getDynamo();
    try {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: deviceKeys.owner(deviceId),
          UpdateExpression: 'SET #ttl = :ttl, updatedAt = :at',
          ConditionExpression: 'userId = :me',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':ttl': ttlAfter(at, INACTIVE_TTL_SECONDS), ':at': at, ':me': userId },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return; // token baska kullaniciya gecmis
      throw toDataAccessError(err);
    }
  }

  return {
    async listByUser(userId) {
      return (await query(userId, VIEW_FIELDS)).map(toDevice);
    },
    async get(userId, deviceId) {
      const { client, tableName } = getDynamo();
      try {
        const out = await client.send(
          new GetCommand({ TableName: tableName, Key: deviceKeys.device(userId, deviceId), ProjectionExpression: VIEW_FIELDS.join(', '), ExpressionAttributeNames: { '#st': 'status' }, ConsistentRead: true }),
        );
        return out.Item ? toDevice(out.Item) : undefined;
      } catch (err) {
        throw toDataAccessError(err);
      }
    },
    getOwner,
    async save(write) {
      const { client, tableName } = getDynamo();
      const d = write.device;
      type Item = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
      const items: Item[] = [
        {
          Put: {
            TableName: tableName,
            Item: { ...deviceKeys.device(d.userId, d.deviceId), entityType: 'PUSH_DEVICE', ...d, updatedAt: d.lastSeenAt },
            // Tazeleme: arada baska kullaniciya tasinan / kaldirilan cihaz bu yazimla dirilmez.
            ...(write.refresh ? { ConditionExpression: 'attribute_exists(PK) AND #st = :active', ExpressionAttributeNames: { '#st': 'status' }, ExpressionAttributeValues: { ':active': 'active' } } : {}),
          },
        },
      ];
      const expected = write.owner.expected;
      if (expected === d.userId) {
        // Sahip zaten bu kullanici: yazim aninda hala oyle olmali; pasif donemde konan ttl kaldirilir.
        items.push({
          Update: {
            TableName: tableName,
            Key: deviceKeys.owner(d.deviceId),
            UpdateExpression: 'SET updatedAt = :at REMOVE #ttl',
            ConditionExpression: 'userId = :me',
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':at': d.lastSeenAt, ':me': d.userId },
          },
        });
      } else {
        items.push({
          Put: {
            TableName: tableName,
            Item: { ...deviceKeys.owner(d.deviceId), entityType: 'PUSH_TOKEN_OWNER', deviceId: d.deviceId, userId: d.userId, updatedAt: d.lastSeenAt },
            ConditionExpression: expected === null ? 'attribute_not_exists(PK)' : 'userId = :prev',
            ...(expected === null ? {} : { ExpressionAttributeValues: { ':prev': expected } }),
          },
        });
      }
      if (write.moveFrom) items.push(deactivateUpdate(deviceKeys.device(write.moveFrom, d.deviceId), 'moved', d.lastSeenAt, tableName, false));
      for (const id of write.evict) items.push(deactivateUpdate(deviceKeys.device(d.userId, id), 'limit', d.lastSeenAt, tableName, true));
      try {
        await sendWithAudit(client, items, write.audit);
      } catch (err) {
        if (err instanceof TransactionCanceledException) throw new DeviceWriteConflict(err);
        throw toDataAccessError(err);
      }
      for (const id of write.evict) await expireOwner(d.userId, id, d.lastSeenAt);
    },
    async deactivate(userId, deviceId, reason, at, options = {}) {
      const { client, tableName } = getDynamo();
      const update = deactivateUpdate(deviceKeys.device(userId, deviceId), reason, at, tableName, true, options.seenBefore);
      try {
        if (options.audit) await sendWithAudit(client, [update], options.audit);
        else await client.send(new UpdateCommand(update.Update));
      } catch (err) {
        if (isConditionFailure(err)) return false;
        throw toDataAccessError(err);
      }
      await expireOwner(userId, deviceId, at);
      return true;
    },
    async listActiveForPush(userId) {
      const items = await query(userId, ['deviceId', 'userId', 'platform', '#st', 'lastSeenAt', '#tok']);
      const active = items
        .filter((i) => i.status === 'active' && isExpoPushToken(i.token) && typeof i.deviceId === 'string')
        .map((i) => ({ deviceId: i.deviceId as string, userId: i.userId as string, platform: i.platform as PushPlatform, lastSeenAt: String(i.lastSeenAt ?? ''), token: i.token as string }))
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
        .slice(0, MAX_ACTIVE_DEVICES);
      if (active.length === 0) return [];
      const owners = await Promise.all(active.map((d) => getOwner(d.deviceId)));
      return active.filter((_, i) => owners[i] === userId);
    },
    async countRegistration(userId, day, at) {
      const { client, tableName } = getDynamo();
      try {
        const out = await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: deviceKeys.rate(userId, day),
            UpdateExpression: 'ADD #c :one SET #ttl = :ttl, entityType = :et',
            ConditionExpression: 'attribute_not_exists(#c) OR #c < :max',
            ExpressionAttributeNames: { '#c': 'count', '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':one': 1, ':max': MAX_REGISTRATIONS_PER_DAY, ':ttl': Math.floor(at.getTime() / 1000) + 2 * 86_400, ':et': 'PUSH_DEVICE_RATE' },
            ReturnValues: 'UPDATED_NEW',
          }),
        );
        return Number(out.Attributes?.count ?? 1);
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) throw new DeviceRateLimitError(secondsUntilIstanbulMidnight(at));
        throw toDataAccessError(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Servis (`/api/me/devices`)
// ---------------------------------------------------------------------------

const view = (d: PushDevice): PushDeviceView => {
  const { userId: _u, ...rest } = d;
  return rest;
};

const MAX_WRITE_ATTEMPTS = 3;

const istanbulDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(d);

function secondsUntilIstanbulMidnight(at: Date): number {
  // Istanbul UTC+3 (yaz saati yok).
  const local = new Date(at.getTime() + 3 * 3600_000);
  const next = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - 3 * 3600_000;
  return Math.max(1, Math.ceil((next - at.getTime()) / 1000));
}

export function createDeviceService(deps: { repository?: DeviceRepository; now?: () => Date } = {}) {
  const repository = deps.repository ?? createDynamoDeviceRepository();
  const now = deps.now ?? (() => new Date());

  return {
    /** Aktif cihazlar, en son gorulen once. */
    async list(userId: string): Promise<{ devices: PushDeviceView[] }> {
      const all = await repository.listByUser(userId);
      return { devices: all.filter((d) => d.status === 'active').sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).map(view) };
    },

    /**
     * Kaydet / tazele. `created`: bu kullanici icin yeni (veya yeniden etkinlesen / baska kullanicidan
     * gelen) kayit. Es zamanli yazimda (sahiplik / durum / sinir kosulu) yeniden okunup en fazla 3 kez
     * denenir. Yeni / tasinan kayit gunluk sayaca tabidir (`MAX_REGISTRATIONS_PER_DAY`, asilirsa 429);
     * tazeleme sayilmaz.
     *
     * Denetim (PLATFORM zinciri): kullanicinin gunun ILK yeni kaydi ve HER baska kullanicidan tasima
     * (hesap degisimi / ele gecirme sinyali). Ayni gun tekrarlanan kayit / kaldirma dongusu denetim
     * zincirini sisirmez; kaldirmalar ise kayitlarla sinirli oldugu icin (gunluk sayac) her zaman denetlenir.
     */
    async register(userId: string, body: unknown): Promise<{ device: PushDeviceView; created: boolean }> {
      const input = parseDeviceInput(body);
      const deviceId = deviceIdOf(input.token);
      let todayCount: number | undefined;
      for (let attempt = 1; ; attempt++) {
        const at = now();
        const iso = at.toISOString();
        const [owner, devices] = await Promise.all([repository.getOwner(deviceId), repository.listByUser(userId)]);
        const existing = devices.find((d) => d.deviceId === deviceId);
        const previousOwner = owner && owner !== userId ? owner : undefined;
        // Eski sahibin kaydi yalnizca hala aktifse pasife alinir (kaldirmis / tasimis olabilir).
        const moveFrom = previousOwner && (await repository.get(previousOwner, deviceId))?.status === 'active' ? previousOwner : undefined;
        const others = devices.filter((d) => d.status === 'active' && d.deviceId !== deviceId).sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
        const evict = others.slice(0, Math.max(0, others.length - (MAX_ACTIVE_DEVICES - 1))).map((d) => d.deviceId);
        const created = !existing || existing.status !== 'active' || Boolean(previousOwner);
        if (created && todayCount === undefined) todayCount = await repository.countRegistration(userId, istanbulDay(at), at);
        const device: PushDevice & { token: string } = {
          deviceId,
          userId,
          platform: input.platform,
          ...(input.appVersion ? { appVersion: input.appVersion } : {}),
          ...(input.locale ? { locale: input.locale } : {}),
          status: 'active',
          createdAt: existing && !created ? existing.createdAt : iso,
          lastSeenAt: iso,
          token: input.token,
        };
        const audited = created && (todayCount === 1 || Boolean(previousOwner));
        try {
          await repository.save({
            device,
            owner: { expected: owner ?? null },
            ...(created ? {} : { refresh: true }),
            ...(moveFrom ? { moveFrom } : {}),
            evict,
            ...(audited
              ? {
                  audit: {
                    action: 'push_device.register',
                    target: { type: 'user', id: userId },
                    actorId: userId,
                    details: { deviceId, platform: input.platform, ...(input.appVersion ? { appVersion: input.appVersion } : {}), ...(previousOwner ? { movedFromAnotherUser: true } : {}), ...(evict.length ? { deactivatedOldest: evict.length } : {}) },
                  },
                }
              : {}),
          });
          const { token: _t, ...stored } = device;
          return { device: view(stored), created };
        } catch (err) {
          if (err instanceof DeviceWriteConflict && attempt < MAX_WRITE_ATTEMPTS) continue;
          throw err;
        }
      }
    },

    /** Kullanicinin kendi cihazini pasife alir (oturum kapatma). Baska kullanicinin cihazi: 404. */
    async remove(userId: string, deviceId: string): Promise<{ device: PushDeviceView }> {
      if (!isDeviceId(deviceId)) throw new ValidationError('deviceId gecersiz', 'deviceId');
      const current = await repository.get(userId, deviceId);
      if (!current) throw new DataAccessError('not_found', 'Cihaz bulunamadı');
      if (current.status !== 'active') return { device: view(current) };
      const at = now().toISOString();
      const changed = await repository.deactivate(userId, deviceId, 'user', at, {
        audit: { action: 'push_device.remove', target: { type: 'user', id: userId }, actorId: userId, details: { deviceId, platform: current.platform } },
      });
      const after = changed ? { ...current, status: 'inactive' as const, deactivatedAt: at, deactivationReason: 'user' as const } : ((await repository.get(userId, deviceId)) ?? current);
      return { device: view(after) };
    },
  };
}

export type DeviceService = ReturnType<typeof createDeviceService>;
