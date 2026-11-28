import { describe, expect, it } from 'vitest';
import { type AuthSession, apiTokenFor, decodeClaims } from './session';

const b64url = (obj: unknown) =>
  btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const claims = { sub: 'u1', role: 'apartment_manager', apartmentId: 'apt-1', exp: 2_000_000_000 };

describe('session', () => {
  it('JWT payload\'indan claim okur', () => {
    const jwt = `${b64url({ alg: 'RS256' })}.${b64url(claims)}.sig`;
    expect(decodeClaims(jwt)).toMatchObject({ sub: 'u1', role: 'apartment_manager', apartmentId: 'apt-1' });
  });

  it('mock token bicimini okur', () => {
    expect(decodeClaims(`mock.${b64url(claims)}`)?.role).toBe('apartment_manager');
  });

  it('rol claim\'i yoksa (baglam secilmemis) oturum gecerli, rol bos', () => {
    const decoded = decodeClaims(`mock.${b64url({ sub: 'u1', exp: 2_000_000_000, apartmentId: 'apt-1' })}`);
    expect(decoded).toMatchObject({ sub: 'u1', role: undefined, apartmentId: undefined });
  });

  it('bilinmeyen rol rol yokmus gibi ele alinir; bozuk token null', () => {
    expect(decodeClaims(`mock.${b64url({ ...claims, role: 'admin' })}`)?.role).toBeUndefined();
    expect(decodeClaims('bozuk')).toBeNull();
    expect(decodeClaims(`mock.${b64url({ role: 'resident', exp: 1 })}`)).toBeNull();
  });

  it("VITE_COGNITO_TOKEN_USE='id' iken ID token'i secer", () => {
    const session = { idToken: 'ID', accessToken: 'ACCESS', claims } as AuthSession;
    expect(apiTokenFor(session, 'id')).toBe('ID');
    expect(apiTokenFor(session, 'access')).toBe('ACCESS');
  });
});
