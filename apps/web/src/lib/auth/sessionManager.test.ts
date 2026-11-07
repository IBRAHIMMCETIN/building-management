import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthAdapter, AuthSession } from './session';

const b64url = (obj: unknown) =>
  btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function session(claims: Record<string, unknown>, tag = 'a'): AuthSession {
  const full = { sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600, ...claims };
  return { idToken: `mock.${b64url(full)}`, accessToken: `access-${tag}`, claims: full as AuthSession['claims'] };
}

const adapter = vi.hoisted(() => ({}) as Record<keyof AuthAdapter, ReturnType<typeof vi.fn>>);

vi.mock('@/config/env', () => ({ env: { tokenUse: 'id', authMode: 'mock', apiUrl: '', cognito: {} } }));
vi.mock('./index', () => ({ authAdapter: adapter }));

async function load(restored: AuthSession | null = null) {
  vi.resetModules();
  for (const key of [
    'restore', 'signIn', 'confirmNewPassword', 'confirmTotp', 'refresh', 'signOut',
    'requestPasswordReset', 'confirmPasswordReset', 'setActiveContext',
  ] as const) {
    adapter[key] = vi.fn();
  }
  adapter.restore.mockResolvedValue(restored);
  const { sessionManager } = await import('./sessionManager');
  await sessionManager.ready;
  return sessionManager;
}

describe('sessionManager', () => {
  beforeEach(() => vi.clearAllMocks());

  it('acilista saklanan oturumu geri yukler ve ID token\'i API token\'i olarak verir', async () => {
    const s = session({ role: 'resident', apartmentId: 'apt-1' });
    const sm = await load(s);
    expect(sm.getState()).toEqual({ status: 'ready', session: s });
    await expect(sm.getApiToken()).resolves.toBe(s.idToken);
  });

  it('challenge adiminda oturum acilmaz, done adiminda acilir', async () => {
    const sm = await load();
    adapter.signIn.mockResolvedValue({ type: 'newPasswordRequired' });
    await sm.signIn({ email: 'a@b.c', password: 'x' });
    expect(sm.getSession()).toBeNull();

    const s = session({ role: 'apartment_manager', apartmentId: 'apt-1' });
    adapter.confirmNewPassword.mockResolvedValue({ type: 'done', session: s });
    await sm.confirmNewPassword('YeniSifre123');
    expect(sm.getSession()).toBe(s);
  });

  it('es zamanli yenilemeler tek cagriyi paylasir', async () => {
    const sm = await load(session({ role: 'resident' }));
    const next = session({ role: 'resident' }, 'b');
    adapter.refresh.mockImplementation(() => new Promise((r) => setTimeout(() => r(next), 10)));
    const [a, b] = await Promise.all([sm.getApiToken({ forceRefresh: true }), sm.getApiToken({ forceRefresh: true })]);
    expect(adapter.refresh).toHaveBeenCalledOnce();
    expect(a).toBe(next.idToken);
    expect(b).toBe(next.idToken);
  });

  it('yenileme basarisizsa oturum duser', async () => {
    const sm = await load(session({ role: 'resident' }));
    adapter.refresh.mockRejectedValue(new Error('revoked'));
    await expect(sm.refresh()).rejects.toThrow(/Oturum/);
    expect(sm.getSession()).toBeNull();
  });

  it('baglam secimi: Pre Token tercihi reddederse hata verir ama yeni token\'i saklar', async () => {
    const sm = await load(session({}));
    const rejected = session({}, 'b'); // rol claim'i yok: tercih dogrulanmadi
    adapter.setActiveContext.mockResolvedValue(rejected);
    await expect(sm.setActiveContext({ apartmentId: 'apt-2', role: 'resident' })).rejects.toThrow(/doğrulanamadı/);
    expect(sm.getSession()).toBe(rejected);
  });

  it('baglam secimi basarili', async () => {
    const sm = await load(session({}));
    const next = session({ role: 'resident', apartmentId: 'apt-2' }, 'b');
    adapter.setActiveContext.mockResolvedValue(next);
    await expect(sm.setActiveContext({ apartmentId: 'apt-2', role: 'resident' })).resolves.toBe(next);
    expect(sm.getSession()?.claims.role).toBe('resident');
  });
});
