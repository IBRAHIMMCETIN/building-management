/**
 * Guvenlik kapisi kaba kuvvet korumasi: QR / kisa kod dogrulamasi (`POST /api/gate/passes/verify`)
 * ve plaka aramasi (`GET /api/gate/plates`) icin kullanici ve apartman basina deneme sinirlari.
 * Sabit pencere (15 dk), DynamoDB sayaci (kosullu `UpdateItem ADD`), `PK = APT#<apartmentId>`:
 *
 *   GTHR#<tur>#U#<userId>#<pencere>   kullanici sayaci: her istek + basarisizlik cezasi (gorevli baska
 *                                     apartmanda ayrica sayilir)
 *   GTHR#verify#A#<pencere>           apartman sayaci: YALNIZCA basarisiz dogrulama ceza puanlari
 *
 * `pencere` = pencere baslangici (epoch sn). Kayit `ttl` (tablonun TTL ozniteligi) ile pencere
 * bitiminden 1 saat sonra DynamoDB tarafindan silinir; uygulamada silme yazimi yoktur.
 *
 * Akis:
 *  1. Kullanici sayaci taban puani (1) kosullu ADD ile tuketir (`count < limit`). Kosul bozulursa
 *     429 + `Retry-After` (pencere sonuna kadar saniye) ve apartman sayacina HIC dokunulmaz: limiti
 *     asmis bir hesap 429 aldikca apartmani kilitleyemez.
 *  2. Kullanici gectiyse apartman sayaci yalnizca OKUNUR; doluysa 429 (tum gorevliler). Apartman
 *     sayaci basarili okumalarla artmaz: yogun bir site mesru kullanimla kendini kilitleyemez.
 *  3. Basarisiz dogrulama (bulunamayan kisa kod / QR jetonu) ceza puanini HEM kullanici HEM apartman
 *     sayacina ekler (kosulsuz ADD). Apartman siniri, birden fazla hesapla dagitilmis kod tahminine
 *     karsidir: tek hesap pencere basina en fazla ~50 ceza puani uretebilir (kullanici siniri).
 * Plaka aramasinda basarisizlik kavrami yoktur (bos sonuc mesrudur): yalnizca kullanici siniri.
 *
 * Siniri ILK asan yazim (`count - weight < limit <= count`) kilitlenmeyi denetim gunlugune
 * (`gate.lockout`) yazar ve `GateLockout` metrigini uretir: sayac basina pencere basina bir kez.
 *
 * API Gateway'deki rota bazli throttling (infra/security_monitoring.tf) istemci basina degil
 * platform genelinde rota basinadir (yalnizca arka ucu korur); istemci basina sinir bu sayactir
 * (ileride Cloudflare ile IP basina).
 */
import type { AuditDraft } from '../audit/log.js';
import type { MetricsEmitter } from '../../observability/metrics.js';

export const THROTTLE_WINDOW_SECONDS = 15 * 60;
/** Sayac kaydi pencere bitiminden bu kadar sonra TTL ile duser. */
export const THROTTLE_TTL_GRACE_SECONDS = 3600;

export type ThrottleKind = 'verify' | 'plates';
export type ThrottleScope = 'user' | 'apartment';

/**
 * Pencere (15 dk) basina puan siniri. Kullanici: her istek 1 + basarisizlik cezasi. Apartman: yalnizca
 * basarisiz dogrulama cezalari (150 = 30 hatali kisa kod veya 150 hatali QR, tum gorevliler toplami;
 * tek hesap kullanici siniri nedeniyle en fazla ~50 uretebilir). Plaka aramasinda apartman siniri yok.
 */
export type ThrottleLimits = Record<ThrottleKind, { user: number; apartment?: number }>;
export const THROTTLE_LIMITS: ThrottleLimits = {
  verify: { user: 60, apartment: 150 },
  plates: { user: 120 },
};

/** Basarisiz kisa kod: kullanicida toplam 6 puan (15 dk'da ~10 hatali kod), apartmanda 5. */
export const FAILED_CODE_PENALTY = 5;
/** Basarisiz QR jetonu (144 bit, tahmin edilemez; yanlis QR okutma olagan): kullanicida 2, apartmanda 1. */
export const FAILED_TOKEN_PENALTY = 1;

export const throttleKeys = {
  user: (kind: ThrottleKind, userId: string, windowStart: number) => `GTHR#${kind}#U#${userId}#${windowStart}`,
  apartment: (kind: ThrottleKind, windowStart: number) => `GTHR#${kind}#A#${windowStart}`,
};

export type ThrottleWindow = { start: number; end: number };

export function windowOf(nowMs: number, size = THROTTLE_WINDOW_SECONDS): ThrottleWindow {
  const start = Math.floor(nowMs / 1000 / size) * size;
  return { start, end: start + size };
}

/** Pencere sonuna kadar saniye (en az 1). */
export const retryAfterSeconds = (nowMs: number, w: ThrottleWindow) => Math.max(1, Math.ceil(w.end - nowMs / 1000));

/** Bu yazim siniri ilk kez mi gecirdi? */
export const crossed = (count: number, weight: number, limit: number) => count >= limit && count - weight < limit;

/** Kosullu sayac: `limit` verilirse yalnizca `count < limit` iken artar (aksi halde `ok: false`). */
export type ThrottleStore = {
  hit(apartmentId: string, sk: string, weight: number, opts: { limit?: number; ttl: number }): Promise<{ ok: boolean; count: number }>;
  get<T>(apartmentId: string, sk: string): Promise<T | undefined>;
  audit(draft: AuditDraft): Promise<void>;
};

export type ThrottleSubject = { apartmentId: string; userId: string; role: string };

/** Sinir asildi: HTTP 429, `Retry-After` saniye. */
export class GateRateLimitError extends Error {
  readonly code = 'rate_limited' as const;
  readonly httpStatus = 429 as const;
  constructor(
    readonly retryAfterSeconds: number,
    readonly kind: ThrottleKind,
    readonly scope: ThrottleScope,
  ) {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    super(
      kind === 'verify'
        ? `Çok fazla geçiş sorgusu yapıldı. Güvenlik nedeniyle ${minutes} dakika sonra tekrar deneyin.`
        : `Çok fazla plaka araması yapıldı. ${minutes} dakika sonra tekrar deneyin.`,
    );
    this.name = 'GateRateLimitError';
  }
}

export type GateThrottle = {
  /** Taban puani tuketir; sinir dolmussa `GateRateLimitError`. */
  consume(subject: ThrottleSubject, kind: ThrottleKind): Promise<void>;
  /** Basarisiz deneme cezasi (kosulsuz; siniri gecirirse kilitlenme denetlenir). */
  penalize(subject: ThrottleSubject, kind: ThrottleKind, weight: number): Promise<void>;
};

export function createGateThrottle(deps: {
  store: ThrottleStore;
  now: () => Date;
  metrics: MetricsEmitter;
  limits?: ThrottleLimits;
  log?: Pick<Console, 'error'>;
}): GateThrottle {
  const limits = deps.limits ?? THROTTLE_LIMITS;
  const log = deps.log ?? console;

  const userKey = (s: ThrottleSubject, kind: ThrottleKind, w: ThrottleWindow) => throttleKeys.user(kind, s.userId, w.start);
  const aptKey = (kind: ThrottleKind, w: ThrottleWindow) => throttleKeys.apartment(kind, w.start);

  /** Kilitlenme: denetim + metrik. Denetim yazilamazsa istek yine reddedilir (sinir sayactadir). */
  async function lockout(s: ThrottleSubject, kind: ThrottleKind, scope: ThrottleScope, w: ThrottleWindow, limit: number) {
    deps.metrics.emit({ GateLockout: 1 }, { msg: 'gate_lockout', apartmentId: s.apartmentId, kind, scope });
    try {
      await deps.store.audit({
        apartmentId: s.apartmentId,
        action: 'gate.lockout',
        target: scope === 'user' ? { type: 'user', id: s.userId } : { type: 'apartment', id: s.apartmentId },
        details: { kind, scope, role: s.role, limit, windowStart: new Date(w.start * 1000).toISOString(), windowSeconds: w.end - w.start },
      });
    } catch (err) {
      log.error(JSON.stringify({ msg: 'gate_lockout_audit_failed', apartmentId: s.apartmentId, kind, scope, error: err instanceof Error ? err.message : 'unknown' }));
    }
  }

  async function consume(s: ThrottleSubject, kind: ThrottleKind) {
    const nowMs = deps.now().getTime();
    const w = windowOf(nowMs);
    const ttl = w.end + THROTTLE_TTL_GRACE_SECONDS;
    const userLimit = limits[kind].user;
    // 1. Once kullanici: limiti asmis hesap apartman sayacina dokunamaz.
    const u = await deps.store.hit(s.apartmentId, userKey(s, kind, w), 1, { limit: userLimit, ttl });
    if (!u.ok) throw new GateRateLimitError(retryAfterSeconds(nowMs, w), kind, 'user');
    if (crossed(u.count, 1, userLimit)) await lockout(s, kind, 'user', w, userLimit);
    // 2. Apartman sayaci yalnizca okunur (basarili okumalar saymaz).
    const aptLimit = limits[kind].apartment;
    if (aptLimit !== undefined) {
      const apt = await deps.store.get<{ count?: number }>(s.apartmentId, aptKey(kind, w));
      if ((apt?.count ?? 0) >= aptLimit) throw new GateRateLimitError(retryAfterSeconds(nowMs, w), kind, 'apartment');
    }
  }

  /** Basarisiz deneme cezasi: kullanici ve (varsa) apartman sayacina; esigi gecen yazim kilitlenmeyi denetler. */
  async function penalize(s: ThrottleSubject, kind: ThrottleKind, weight: number) {
    if (weight <= 0) return;
    const w = windowOf(deps.now().getTime());
    const ttl = w.end + THROTTLE_TTL_GRACE_SECONDS;
    const userLimit = limits[kind].user;
    const aptLimit = limits[kind].apartment;
    const [u, a] = await Promise.all([
      deps.store.hit(s.apartmentId, userKey(s, kind, w), weight, { ttl }),
      aptLimit !== undefined ? deps.store.hit(s.apartmentId, aptKey(kind, w), weight, { ttl }) : Promise.resolve(undefined),
    ]);
    if (crossed(u.count, weight, userLimit)) await lockout(s, kind, 'user', w, userLimit);
    if (a && aptLimit !== undefined && crossed(a.count, weight, aptLimit)) await lockout(s, kind, 'apartment', w, aptLimit);
  }

  return { consume, penalize };
}
