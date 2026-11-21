import type { AuthClaims, AuthIdentity } from '../../auth/claims.js';
import { type MfaDecision, type MfaPolicy, MFA_ROLES, evaluateMfa, isMfaRole, loadMfaPolicy } from '../../auth/mfa.js';
import { type GrantItem, queryGrantItems, toGrants } from '../../auth/preTokenGeneration.js';
import { appendAudit, type AuditDraft } from '../audit/log.js';
import { ValidationError, asObject } from '../core/validation.js';
import { type MetricsEmitter, noopMetrics } from '../../observability/metrics.js';
import { MfaError } from './errors.js';
import { type MfaProvider, type MfaUserInfo, createCognitoMfaProvider, createMockMfaProvider } from './provider.js';

/** Dogrulayici uygulamada gorunen hesap adi (otpauth `issuer`). */
export const TOTP_ISSUER = 'YÖNESİST';

/** MFA sifirlayabilen roller; apartman rolleri yalnizca kendi apartmanindaki kullanicilar icin. */
export const MFA_RESET_ROLES = ['platform_admin', 'apartment_manager', 'management_company'] as const;

export type MfaStatusView = {
  mode: MfaPolicy['mode'];
  graceDays: number;
  /** Aktif rol zorunlu MFA kapsaminda mi. */
  roleRequiresMfa: boolean;
  enabled: boolean;
  status: MfaDecision['status'];
  graceUntil?: string;
};

export type MfaSetup = { secretCode: string; otpauthUri: string; issuer: string; account: string };

export type MfaResetResult = { userId: string; reset: true; signedOut: true };

/** Yonetici gorunumu: hedef kullanicinin MFA durumu ve sifirlanabilirligi. */
export type MfaUserView = MfaUserInfo & {
  canReset: boolean;
  /** Sifirlanamiyorsa nedeni (arayuzde gosterilir). */
  blockedReason?: string;
  /** Yalnizca platform aramasinda. */
  isPlatformAdmin?: boolean;
};

export type MfaServiceDeps = {
  provider: MfaProvider;
  policy: MfaPolicy;
  loadGrantItems: (userId: string) => Promise<GrantItem[]>;
  audit: (draft: AuditDraft) => Promise<unknown>;
  /** EMF: MfaVerifyFailed, MfaReset (alarmlar). */
  metrics: MetricsEmitter;
  now: () => Date;
};

export type MfaService = {
  status(identity: AuthIdentity): Promise<MfaStatusView>;
  beginSetup(identity: AuthIdentity, accessToken: string | undefined): Promise<MfaSetup>;
  completeSetup(identity: AuthIdentity, accessToken: string | undefined, body: unknown): Promise<{ enabled: true }>;
  reset(actor: AuthClaims, targetUserId: string, body: unknown): Promise<MfaResetResult>;
  /** Yonetici: hedef kullanicinin MFA durumu (sifirlama ile ayni yetki kurallari). */
  userStatus(actor: AuthClaims, targetUserId: string): Promise<MfaUserView>;
  /** Yalnizca platform_admin: e-postayla kullanici bulur. */
  findUser(actor: AuthClaims, email: string): Promise<MfaUserView>;
};

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const istanbulDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(d);

function decodePayload(token: string): Record<string, unknown> | undefined {
  try {
    const segment = token.startsWith('mock.') ? token.slice(5) : token.split('.')[1];
    if (!segment) return undefined;
    const raw: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Kurulum, istegi yapan kullanicinin KENDI access token'i ile yapilmalidir. Imzayi Cognito
 * dogrular; burada yalnizca token'in bu kimlige ait bir access token oldugu kontrol edilir
 * (baska bir kullanicinin token'i bu oturumla karistirilmasin).
 */
function assertOwnAccessToken(token: string | undefined, identity: AuthIdentity, provider: MfaProvider): string {
  if (!token) throw new MfaError('access_token_invalid', 'Access token gerekli (X-Cognito-Access-Token)');
  const payload = decodePayload(token);
  const isAccess = payload?.token_use === 'access' || (provider.kind === 'mock' && token.startsWith('mock.'));
  if (!payload || payload.sub !== identity.userId || !isAccess) {
    throw new MfaError('access_token_invalid', 'Access token bu oturuma ait değil');
  }
  return token;
}

function otpauthUri(account: string, secret: string): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${account}`);
  const params = new URLSearchParams({ secret, issuer: TOTP_ISSUER, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function createMfaService(overrides: Partial<MfaServiceDeps> = {}): MfaService {
  const deps: MfaServiceDeps = {
    provider: overrides.provider ?? defaultProvider(),
    policy: overrides.policy ?? loadMfaPolicy(),
    loadGrantItems: (userId) => queryGrantItems(userId),
    audit: (draft) => appendAudit(draft),
    metrics: noopMetrics,
    now: () => new Date(),
    ...overrides,
  };
  const { provider, policy } = deps;

  return {
    async status(identity) {
      const enabled = await provider.isEnabled(identity.userId);
      const role = identity.claims?.role ?? (identity.groups.includes('platform_admin') ? 'platform_admin' : undefined);
      const decision = evaluateMfa(
        {
          role,
          mfaEnabled: enabled,
          graceUntil: identity.claims?.mfaGraceUntil,
          mfaRequired: identity.claims?.mfaRequired,
        },
        policy,
        deps.now(),
      );
      return {
        mode: policy.mode,
        graceDays: policy.graceDays,
        roleRequiresMfa: isMfaRole(role),
        enabled,
        status: decision.status,
        ...(decision.graceUntil ? { graceUntil: decision.graceUntil } : {}),
      };
    },

    async beginSetup(identity, accessToken) {
      const token = assertOwnAccessToken(accessToken, identity, provider);
      const { secretCode } = await provider.associate(token);
      const account = identity.email ?? identity.userId;
      return { secretCode, otpauthUri: otpauthUri(account, secretCode), issuer: TOTP_ISSUER, account };
    },

    async completeSetup(identity, accessToken, body) {
      const token = assertOwnAccessToken(accessToken, identity, provider);
      const o = asObject(body);
      const code = typeof o.code === 'string' ? o.code.trim() : '';
      if (!/^\d{6}$/.test(code)) throw new ValidationError('code 6 haneli olmalıdır', 'code');
      const rawName = o.deviceName === undefined ? 'Doğrulayıcı' : o.deviceName;
      if (typeof rawName !== 'string' || rawName.trim().length === 0 || rawName.length > 60) {
        throw new ValidationError('deviceName 1-60 karakter olmalıdır', 'deviceName');
      }
      try {
        await provider.verify(token, code, rawName.trim());
      } catch (err) {
        if (err instanceof MfaError && err.code === 'invalid_code') {
          deps.metrics.emit({ MfaVerifyFailed: 1 }, { msg: 'mfa_verify_failed' });
        }
        throw err;
      }
      // Etkinlestirmeden ONCE denetim: kayit yazilamazsa MFA tercihi acilmaz (kullanici tekrar dener).
      await deps.audit({
        action: 'mfa.totp.enable',
        target: { type: 'user', id: identity.userId },
        actorId: identity.userId,
        details: { deviceName: rawName.trim() },
      });
      await provider.enable(token);
      return { enabled: true };
    },

    async reset(actor, targetUserId, body) {
      assertResetActor(actor);
      const o = asObject(body);
      const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
      if (reason.length < 10 || reason.length > 500) {
        throw new ValidationError('reason 10-500 karakter olmalıdır (ör. cihaz kaybı, talep no)', 'reason');
      }
      const { apartmentId, blockedReason } = await assess(actor, targetUserId);
      if (blockedReason) throw new MfaError('forbidden', blockedReason);

      // Kapali-hata: denetim kaydi yazilamazsa sifirlama yapilmaz.
      const draft = {
        ...(apartmentId ? { apartmentId } : {}),
        target: { type: 'user', id: targetUserId },
        reason,
      };
      await deps.audit({ ...draft, action: 'mfa.reset', details: { globalSignOut: true } });
      try {
        await provider.adminReset(targetUserId);
      } catch (err) {
        await deps
          .audit({ ...draft, action: 'mfa.reset.failed', details: { error: err instanceof Error ? err.name : 'unknown' } })
          .catch(() => undefined);
        throw err;
      }
      deps.metrics.emit({ MfaReset: 1 }, { msg: 'mfa_reset', scope: apartmentId ? 'apartment' : 'platform' });
      return { userId: targetUserId, reset: true, signedOut: true };
    },

    async userStatus(actor, targetUserId) {
      assertResetActor(actor);
      const { info, blockedReason } = await assess(actor, targetUserId);
      return { ...info, canReset: !blockedReason, ...(blockedReason ? { blockedReason } : {}) };
    },

    async findUser(actor, email) {
      if (actor.role !== 'platform_admin' || actor.supportSessionId) {
        throw new MfaError('forbidden', 'Kullanıcı aramasını yalnızca platform yöneticisi yapabilir');
      }
      const normalized = email.trim().toLowerCase();
      if (!EMAIL.test(normalized)) throw new ValidationError('Geçerli bir e-posta girin', 'email');
      const info = await provider.lookup(normalized);
      if (!info) throw new MfaError('not_found', 'Bu e-postaya ait kullanıcı bulunamadı');
      const self = info.userId === actor.userId;
      return {
        ...info,
        isPlatformAdmin: await provider.isPlatformAdmin(info.userId),
        canReset: !self,
        ...(self ? { blockedReason: SELF_RESET } : {}),
      };
    },
  };

  /**
   * Hedef kullanici yetki kurallari (durum okuma ve sifirlama ortak):
   *  - platform_admin: herkes (kendisi haric). Denetim PLATFORM zincirine.
   *  - apartman rolleri: hedef aktif apartmanda yetkili olmali (yoksa 404: varligi sizdirilmaz).
   *    Baska apartmanda yonetici/denetci olan ve platform_admin olan kullanici sifirlanamaz.
   */
  async function assess(
    actor: AuthClaims,
    targetUserId: string,
  ): Promise<{ apartmentId?: string; info: MfaUserInfo; blockedReason?: string }> {
    if (!USER_ID.test(targetUserId)) throw new ValidationError('Geçersiz kullanıcı kimliği', 'userId');
    const self = targetUserId === actor.userId ? SELF_RESET : undefined;
    if (actor.role === 'platform_admin') {
      const info = await provider.lookup(targetUserId);
      if (!info) throw new MfaError('not_found', 'Kullanıcı bulunamadı');
      return { info, ...(self ? { blockedReason: self } : {}) };
    }
    const apartmentId = actor.apartmentId;
    if (!apartmentId) throw new MfaError('forbidden', 'Aktif apartman bağlamı gerekli');
    const fallback: MfaUserInfo = { userId: targetUserId, mfaEnabled: false, accountEnabled: false };
    if (self) return { apartmentId, info: (await provider.lookup(targetUserId)) ?? fallback, blockedReason: self };
    const grants = toGrants(await deps.loadGrantItems(targetUserId), istanbulDate(deps.now()));
    if (!grants.some((g) => g.apartmentId === apartmentId)) {
      throw new MfaError('not_found', 'Bu apartmanda kullanıcı bulunamadı');
    }
    const info = (await provider.lookup(targetUserId)) ?? fallback;
    let blockedReason: string | undefined;
    if (grants.some((g) => g.apartmentId !== apartmentId && (MFA_ROLES as readonly string[]).includes(g.role))) {
      blockedReason = 'Kullanıcının başka apartmanda yönetici/denetçi yetkisi var; platform ekibine başvurun.';
    }
    if (!blockedReason && (await provider.isPlatformAdmin(targetUserId))) {
      blockedReason = 'Platform yöneticisinin doğrulayıcısını yalnızca platform ekibi sıfırlayabilir.';
    }
    return { apartmentId, info, ...(blockedReason ? { blockedReason } : {}) };
  }
}

const SELF_RESET = 'Kendi doğrulayıcınızı sıfırlayamazsınız; başka bir yetkiliye başvurun.';

function assertResetActor(actor: AuthClaims) {
  if (!(MFA_RESET_ROLES as readonly string[]).includes(actor.role) || actor.supportSessionId) {
    throw new MfaError('forbidden', 'MFA sıfırlama yetkiniz yok');
  }
}

/** Lambda'da Cognito (COGNITO_USER_POOL_ID); yerel mock modunda bellek ici saglayici. */
function defaultProvider(env: NodeJS.ProcessEnv = process.env): MfaProvider {
  if (env.COGNITO_USER_POOL_ID) return createCognitoMfaProvider(env.COGNITO_USER_POOL_ID);
  if (env.AWS_LAMBDA_FUNCTION_NAME || env.NODE_ENV === 'production') {
    // Yapilandirma hatasi: uclar 503 doner, sessizce sahteye dusmez.
    const unavailable = async (): Promise<never> => {
      throw new MfaError('unavailable', 'MFA servisi yapılandırılmamış (COGNITO_USER_POOL_ID)');
    };
    return {
      kind: 'cognito',
      lookup: unavailable,
      isEnabled: unavailable,
      associate: unavailable,
      verify: unavailable,
      enable: unavailable,
      adminReset: unavailable,
      isPlatformAdmin: unavailable,
    };
  }
  return createMockMfaProvider();
}
