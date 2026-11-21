import type { AuthClaims, AuthIdentity } from '../../auth/claims.js';
import { type MfaDecision, type MfaPolicy, MFA_ROLES, evaluateMfa, isMfaRole, loadMfaPolicy } from '../../auth/mfa.js';
import { type GrantItem, queryGrantItems, toGrants } from '../../auth/preTokenGeneration.js';
import { appendAudit, type AuditDraft } from '../audit/log.js';
import { ValidationError, asObject } from '../core/validation.js';
import { MfaError } from './errors.js';
import { type MfaProvider, createCognitoMfaProvider, createMockMfaProvider } from './provider.js';

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

export type MfaServiceDeps = {
  provider: MfaProvider;
  policy: MfaPolicy;
  loadGrantItems: (userId: string) => Promise<GrantItem[]>;
  audit: (draft: AuditDraft) => Promise<unknown>;
  now: () => Date;
};

export type MfaService = {
  status(identity: AuthIdentity): Promise<MfaStatusView>;
  beginSetup(identity: AuthIdentity, accessToken: string | undefined): Promise<MfaSetup>;
  completeSetup(identity: AuthIdentity, accessToken: string | undefined, body: unknown): Promise<{ enabled: true }>;
  reset(actor: AuthClaims, targetUserId: string, body: unknown): Promise<MfaResetResult>;
};

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
      await provider.verify(token, code, rawName.trim());
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
      if (!(MFA_RESET_ROLES as readonly string[]).includes(actor.role) || actor.supportSessionId) {
        throw new MfaError('forbidden', 'MFA sıfırlama yetkiniz yok');
      }
      if (!USER_ID.test(targetUserId)) throw new ValidationError('Geçersiz kullanıcı kimliği', 'userId');
      if (targetUserId === actor.userId) {
        throw new MfaError('forbidden', 'Kendi doğrulayıcınızı sıfırlayamazsınız; başka bir yetkiliye başvurun.');
      }
      const o = asObject(body);
      const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
      if (reason.length < 10 || reason.length > 500) {
        throw new ValidationError('reason 10-500 karakter olmalıdır (ör. cihaz kaybı, talep no)', 'reason');
      }

      let apartmentId: string | undefined;
      if (actor.role === 'platform_admin') {
        // Kullanici var mi (yoksa 404).
        await provider.isEnabled(targetUserId);
      } else {
        apartmentId = actor.apartmentId;
        if (!apartmentId) throw new MfaError('forbidden', 'Aktif apartman bağlamı gerekli');
        const grants = toGrants(await deps.loadGrantItems(targetUserId), istanbulDate(deps.now()));
        // Baska apartmanin kullanicisinin varligi sizdirilmaz: 404.
        if (!grants.some((g) => g.apartmentId === apartmentId)) {
          throw new MfaError('not_found', 'Bu apartmanda kullanıcı bulunamadı');
        }
        if (grants.some((g) => g.apartmentId !== apartmentId && (MFA_ROLES as readonly string[]).includes(g.role))) {
          throw new MfaError('forbidden', 'Kullanıcının başka apartmanda yönetici/denetçi yetkisi var; platform ekibine başvurun.');
        }
        if (await provider.isPlatformAdmin(targetUserId)) {
          throw new MfaError('forbidden', 'Platform yöneticisinin doğrulayıcısını yalnızca platform ekibi sıfırlayabilir.');
        }
      }

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
      return { userId: targetUserId, reset: true, signedOut: true };
    },
  };
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
