import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { AuthClaims, Authenticator } from '../../auth/claims.js';
import { getTenantItem, queryTenantAll, skKey, tenantPk } from '../../config/dynamodb.js';
import { setRequestActor } from '../audit/context.js';
import { appendAudit, auditedPutNew, auditedPutVersioned } from '../audit/log.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import { CoreError } from '../core/service.js';
import type { TableKeys } from '../core/types.js';
import { ValidationError, asObject, assertId, optInt, reqString } from '../core/validation.js';

/**
 * `platform_admin` destek erisimi (G1).
 *
 * Platform yoneticisi apartman verisini normalde goremez. Destek icin gerekceli (en az 20
 * karakter) ve sureli (en fazla 60 dk) bir oturum acar; istekte `X-Support-Session` basligiyla
 * o apartmana SALT OKUNUR (`observer`) erisir. Oturumun acilisi, kapanisi ve pencere icindeki
 * HER istek apartmanin denetim zincirine yazilir; denetim yazilamazsa istek reddedilir (fail
 * closed). Apartman yoneticisi bu kayitlari kendi denetim gunlugunde gorur.
 *
 *   PK = `APT#<apartmentId>`, SK = `SUPPORT#<sessionId>`  (ana tablo)
 *   Baslik degeri: `<apartmentId>.<sessionId>`
 */

export const SUPPORT_HEADER = 'x-support-session';
export const SUPPORT_MAX_MINUTES = 60;
export const SUPPORT_MIN_MINUTES = 5;
export const SUPPORT_REASON_MIN = 20;

export type SupportSession = TableKeys & {
  entityType: 'SUPPORT_SESSION';
  sessionId: string;
  apartmentId: string;
  adminUserId: string;
  reason: string;
  startedAt: string;
  expiresAt: string;
  endedAt?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  version: number;
};

export const supportKeys = {
  session: (apartmentId: string, sessionId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('SUPPORT', sessionId) }),
};

export type SupportRepository = {
  get(apartmentId: string, sessionId: string): Promise<SupportSession | undefined>;
  list(apartmentId: string): Promise<SupportSession[]>;
  create(session: SupportSession): Promise<void>;
  update(session: SupportSession, expectedVersion: number): Promise<void>;
};

export const supportRepository: SupportRepository = {
  get: (apt, id) => getTenantItem<SupportSession>(supportKeys.session(apt, id)),
  list: (apt) => queryTenantAll<SupportSession>(apt, 'SUPPORT#', { ConsistentRead: true }),
  create: (s) =>
    auditedPutNew(s, {
      apartmentId: s.apartmentId,
      action: 'support.session.start',
      target: { type: 'support_session', id: s.sessionId },
      actorId: s.adminUserId,
      reason: s.reason,
      details: { expiresAt: s.expiresAt },
    }),
  update: (s, v) =>
    auditedPutVersioned(s, v, {
      apartmentId: s.apartmentId,
      action: 'support.session.end',
      target: { type: 'support_session', id: s.sessionId },
      actorId: s.updatedBy,
      details: { endedAt: s.endedAt, expiresAt: s.expiresAt },
    }),
};

export type SupportDeps = {
  repository: SupportRepository;
  core: Pick<CoreRepository, 'getSite'>;
  now: () => Date;
  newId: () => string;
  /** Pencere icindeki istek kaydi (varsayilan: denetim zincirine ekleme). */
  recordRequest: (session: SupportSession, request: { method: string; path: string }) => Promise<void>;
};

const isActive = (s: SupportSession, now: Date) => !s.endedAt && Date.parse(s.expiresAt) > now.getTime();

export const view = (s: SupportSession, now: Date) => ({
  sessionId: s.sessionId,
  apartmentId: s.apartmentId,
  adminUserId: s.adminUserId,
  reason: s.reason,
  startedAt: s.startedAt,
  expiresAt: s.expiresAt,
  endedAt: s.endedAt,
  active: isActive(s, now),
  header: `${s.apartmentId}.${s.sessionId}`,
});

export function parseSupportHeader(value: string): { apartmentId: string; sessionId: string } | undefined {
  const m = /^([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{8,64})$/.exec(value.trim());
  return m ? { apartmentId: m[1] as string, sessionId: m[2] as string } : undefined;
}

export function createSupportService(overrides: Partial<SupportDeps> = {}) {
  const deps: SupportDeps = {
    repository: supportRepository,
    core: coreRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    recordRequest: async (s, r) => {
      await appendAudit({
        apartmentId: s.apartmentId,
        action: 'support.request',
        target: { type: 'support_session', id: s.sessionId },
        actorId: s.adminUserId,
        details: { method: r.method, path: r.path },
      });
    },
    ...overrides,
  };

  async function start(admin: AuthClaims, body: unknown) {
    const o = asObject(body);
    const apartmentId = assertId(o.apartmentId, 'apartmentId');
    const reason = reqString(o, 'reason', 500).trim();
    if (reason.length < SUPPORT_REASON_MIN) {
      throw new ValidationError(`Gerekce en az ${SUPPORT_REASON_MIN} karakter olmali`, 'reason');
    }
    const minutes = optInt(o, 'durationMinutes', SUPPORT_MIN_MINUTES, SUPPORT_MAX_MINUTES) ?? SUPPORT_MAX_MINUTES;
    const site = await deps.core.getSite(apartmentId);
    if (!site) throw new CoreError('not_found', 'Apartman bulunamadi');

    const now = deps.now();
    const ts = now.toISOString();
    const sessionId = deps.newId().replaceAll('-', '');
    const session: SupportSession = {
      ...supportKeys.session(apartmentId, sessionId),
      entityType: 'SUPPORT_SESSION',
      sessionId,
      apartmentId,
      adminUserId: admin.userId,
      reason,
      startedAt: ts,
      expiresAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
      createdAt: ts,
      createdBy: admin.userId,
      updatedAt: ts,
      updatedBy: admin.userId,
      version: 1,
    };
    await deps.repository.create(session);
    return view(session, now);
  }

  async function end(admin: AuthClaims, apartmentId: string, sessionId: string) {
    assertId(apartmentId, 'apartmentId');
    assertId(sessionId, 'sessionId');
    const s = await deps.repository.get(apartmentId, sessionId);
    if (!s || s.adminUserId !== admin.userId) throw new CoreError('not_found', 'Destek oturumu bulunamadi');
    const now = deps.now();
    if (s.endedAt) return view(s, now);
    const next: SupportSession = { ...s, endedAt: now.toISOString(), updatedAt: now.toISOString(), updatedBy: admin.userId, version: s.version + 1 };
    await deps.repository.update(next, s.version);
    return view(next, now);
  }

  async function list(apartmentId: string) {
    assertId(apartmentId, 'apartmentId');
    const now = deps.now();
    return (await deps.repository.list(apartmentId))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((s) => view(s, now));
  }

  /** Baslik -> etkin oturum (yalnizca acan yonetici, suresi dolmamis, bitirilmemis). */
  async function resolve(header: string, adminUserId: string): Promise<SupportSession | undefined> {
    const parsed = parseSupportHeader(header);
    if (!parsed) return undefined;
    const s = await deps.repository.get(parsed.apartmentId, parsed.sessionId);
    if (!s || s.adminUserId !== adminUserId || !isActive(s, deps.now())) return undefined;
    return s;
  }

  return { start, end, list, resolve, recordRequest: deps.recordRequest };
}

export type SupportService = ReturnType<typeof createSupportService>;

/**
 * Kimlik dogrulayiciyi destek erisimiyle sarar. Baslik yoksa davranis degismez. Baslik varsa:
 * yalnizca `platform_admin` kullanabilir; gecersiz/suresi dolmus oturum 401. Gecerliyse istek
 * once denetime yazilir (yazilamazsa hata, istek islenmez), sonra claim'ler apartmana bagli
 * salt okunur `observer` olarak doner.
 */
export function withSupportAccess(authenticate: Authenticator, support: Pick<SupportService, 'resolve' | 'recordRequest'>): Authenticator {
  return async (c: Context) => {
    const claims = await authenticate(c);
    if (!claims) return null;
    const header = c.req.header(SUPPORT_HEADER);
    if (!header) return claims;
    if (claims.role !== 'platform_admin') return null;
    const session = await support.resolve(header, claims.userId);
    if (!session) return null;
    setRequestActor({ userId: claims.userId, role: 'platform_admin', supportSessionId: session.sessionId });
    await support.recordRequest(session, { method: c.req.method, path: new URL(c.req.url).pathname });
    return { userId: claims.userId, role: 'observer', apartmentId: session.apartmentId, supportSessionId: session.sessionId };
  };
}
