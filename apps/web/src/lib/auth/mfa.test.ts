import { describe, expect, it } from 'vitest';
import { graceText } from '@/components/MfaGraceBanner';
import { formatSecret, mfaGraceDaysLeft, needsMfaSetup } from './mfa';
import { type SessionClaims, decodeClaims } from './session';

const b64url = (obj: unknown) =>
  btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const NOW = new Date('2026-11-21T10:00:00.000Z');
const manager = (mfa?: SessionClaims['mfa']): SessionClaims => ({
  sub: 'u1',
  role: 'apartment_manager',
  apartmentId: 'apt-1',
  exp: 2_000_000_000,
  ...(mfa ? { mfa } : {}),
});

describe('MFA claim\'leri', () => {
  it('Cognito metin claim\'lerini okur; rol yoksa MFA da yok', () => {
    const token = `mock.${b64url({ sub: 'u1', exp: 2_000_000_000, role: 'observer', apartmentId: 'a', mfa_enabled: 'false', mfa_grace_until: '2026-11-28T10:00:00.000Z' })}`;
    expect(decodeClaims(token)?.mfa).toEqual({ enabled: false, required: false, graceUntil: '2026-11-28T10:00:00.000Z' });
    expect(decodeClaims(`mock.${b64url({ sub: 'u1', exp: 2_000_000_000, role: 'observer', mfa_required: 'true' })}`)?.mfa).toEqual({ enabled: false, required: true });
    expect(decodeClaims(`mock.${b64url({ sub: 'u1', exp: 2_000_000_000, role: 'resident' })}`)?.mfa).toBeUndefined();
    expect(decodeClaims(`mock.${b64url({ sub: 'u1', exp: 2_000_000_000, mfa_required: 'true' })}`)?.mfa).toBeUndefined();
  });
});

describe('needsMfaSetup', () => {
  it('token zorunlu diyorsa veya API MFA_REQUIRED donduyse; etkinse asla', () => {
    expect(needsMfaSetup(manager({ enabled: false, required: true }))).toBe(true);
    expect(needsMfaSetup(manager({ enabled: false, required: false }), true)).toBe(true);
    expect(needsMfaSetup(manager({ enabled: true, required: false }), true)).toBe(false);
    expect(needsMfaSetup(manager({ enabled: false, required: false, graceUntil: '2026-11-28T10:00:00.000Z' }))).toBe(false);
    expect(needsMfaSetup(manager())).toBe(false);
    expect(needsMfaSetup({ sub: 'u1', exp: 1 }, true)).toBe(false);
    expect(needsMfaSetup(null)).toBe(false);
  });
});

describe('gecis suresi', () => {
  it('kalan gun yukari yuvarlanir, gecmis 0; zorunlu/etkin/sure yoksa undefined', () => {
    expect(mfaGraceDaysLeft(manager({ enabled: false, required: false, graceUntil: '2026-11-28T10:00:00.000Z' }), NOW)).toBe(7);
    expect(mfaGraceDaysLeft(manager({ enabled: false, required: false, graceUntil: '2026-11-21T12:00:00.000Z' }), NOW)).toBe(1);
    expect(mfaGraceDaysLeft(manager({ enabled: false, required: false, graceUntil: '2026-11-20T00:00:00.000Z' }), NOW)).toBe(0);
    expect(mfaGraceDaysLeft(manager({ enabled: false, required: true, graceUntil: '2026-11-28T10:00:00.000Z' }), NOW)).toBeUndefined();
    expect(mfaGraceDaysLeft(manager({ enabled: true, required: false }), NOW)).toBeUndefined();
    expect(mfaGraceDaysLeft(manager(), NOW)).toBeUndefined();
  });

  it('banner metni ve anahtar bicimi', () => {
    expect(graceText(5)).toBe('5 gün içinde');
    expect(graceText(1)).toBe('bugün');
    expect(graceText(0)).toBe('bugün');
    expect(formatSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(formatSecret('ABCDEF')).toBe('ABCD EF');
  });
});
