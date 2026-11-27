/**
 * Guvenlik kapisi kaba kuvvet korumasi: QR / kisa kod dogrulamasi (`POST /api/gate/passes/verify`)
 * ve plaka aramasi (`GET /api/gate/plates`) icin kullanici ve apartman basina deneme sinirlari.
 * Sabit pencere (15 dk), DynamoDB sayaci (kosullu `UpdateItem ADD`), `PK = APT#<apartmentId>`:
 *
 *   GTHR#<tur>#U#<userId>#<pencere>   kullanici sayaci (gorevli baska apartmanda ayrica sayilir)
 *   GTHR#<tur>#A#<pencere>            apartman sayaci (o apartmandaki tum gorevli / yoneticiler)
 *
 * `pencere` = pencere baslangici (epoch sn). Kayit `ttl` (tablonun TTL ozniteligi) ile pencere
 * bitiminden 1 saat sonra DynamoDB tarafindan silinir; uygulamada silme yazimi yoktur.
 *
 * Akis: istek once taban puanini (1) kosullu ADD ile tuketir (`count < limit`); kosul bozulursa
 * 429 + `Retry-After` (pencere sonuna kadar saniye). Basarisiz kisa kod dogrulamasi ek ceza puani
 * ekler (kosulsuz ADD): 8 karakterlik kod tahmini hizla kilitlenir, basarili okumalar dar bir
 * kapida bile siniri zorlamaz. Siniri ILK asan yazim (`count - weight < limit <= count`) kilitlenmeyi
 * denetim gunlugune (`gate.lockout`) yazar ve `GateLockout` metrigini uretir: sayac basina pencere
 * basina bir kez (sayac yalnizca artar, esigi tek bir yazim gecer).
 *
 * API Gateway'deki rota bazli throttling (infra/security_monitoring.tf) istemci basina degildir;
 * bu sinir kullanici ve apartman basinadir. Ikisi birbirini tamamlar.
 */
import type { AuditDraft } from '../audit/log.js';
import type { MetricsEmitter } from '../../observability/metrics.js';

export const THROTTLE_WINDOW_SECONDS = 15 * 60;
/** Sayac kaydi pencere bitiminden bu kadar sonra TTL ile duser. */
export const THROTTLE_TTL_GRACE_SECONDS = 3600;

export type ThrottleKind = 'verify' | 'plates';
export type ThrottleScope = 'user' | 'apartment';

/** Pencere (15 dk) basina puan siniri. Her istek 1 puan; ceza puanlari asagida. */
export const THROTTLE_LIMITS: Record<ThrottleKind, Record<ThrottleScope, number>> = {
  verify: { user: 60, apartment: 300 },
  plates: { user: 120, apartment: 600 },
};

/** Basarisiz kisa kod: toplam 6 puan (kullanici basina 15 dk'da ~10 hatali kod). */
export const FAILED_CODE_PENALTY = 5;
/** Basarisiz QR jetonu (144 bit, tahmin edilemez; yanlis QR okutma olagan): toplam 2 puan. */
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
  limits?: Record<ThrottleKind, Record<ThrottleScope, number>>;
  log?: Pick<Console, 'error'>;
}): GateThrottle {
  const limits = deps.limits ?? THROTTLE_LIMITS;
  const log = deps.log ?? console;

  function counters(s: ThrottleSubject, kind: ThrottleKind, w: ThrottleWindow) {
    return [
      { scope: 'user' as const, sk: throttleKeys.user(kind, s.userId, w.start), limit: limits[kind].user },
      { scope: 'apartment' as const, sk: throttleKeys.apartment(kind, w.start), limit: limits[kind].apartment },
    ];
  }

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
    const results = await Promise.all(
      counters(s, kind, w).map(async (c) => ({ ...c, ...(await deps.store.hit(s.apartmentId, c.sk, 1, { limit: c.limit, ttl })) })),
    );
    for (const r of results) if (r.ok && crossed(r.count, 1, r.limit)) await lockout(s, kind, r.scope, w, r.limit);
    const blocked = results.find((r) => !r.ok);
    if (blocked) throw new GateRateLimitError(retryAfterSeconds(nowMs, w), kind, blocked.scope);
  }

  async function penalize(s: ThrottleSubject, kind: ThrottleKind, weight: number) {
    if (weight <= 0) return;
    const w = windowOf(deps.now().getTime());
    const ttl = w.end + THROTTLE_TTL_GRACE_SECONDS;
    const results = await Promise.all(counters(s, kind, w).map(async (c) => ({ ...c, ...(await deps.store.hit(s.apartmentId, c.sk, weight, { ttl })) })));
    for (const r of results) if (crossed(r.count, weight, r.limit)) await lockout(s, kind, r.scope, w, r.limit);
  }

  return { consume, penalize };
}
