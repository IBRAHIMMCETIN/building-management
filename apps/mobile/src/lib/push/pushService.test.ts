import { ApiError, NetworkError } from '@bm/shared/api/errors';
import type { AuthSession } from '@bm/shared/auth/session';
import type { ApiClient } from '@/lib/api/createApiClient';
import { createMockAuthAdapter } from '@/lib/auth/mockAdapter';
import { createServices } from '@/services';
import { expoTokenOf, fakeNotifications } from '@/test/notifications';
import { TEST_ENV, memoryStorage, mockApi } from '@/test/renderApp';
import { PushService, RETRY_BACKOFF_MS } from './pushService';

/* Push kayit yasam dongusu: izin, EAS projesi, token olaylari, cikis yarisi, cevrimdisi cikis, 429. */

const session = (sub = 'u1', apartmentId = 'apt-1') => ({ claims: { sub, apartmentId, role: 'resident' }, idToken: `tok-${sub}` }) as unknown as AuthSession;
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await tick();
};

type DeleteOpts = { auth?: boolean; headers?: Record<string, string> } | undefined;

function setup(init: Parameters<typeof fakeNotifications>[0] = {}, opts: { post?: jest.Mock; del?: jest.Mock } = {}) {
  const adapter = fakeNotifications(init);
  const storage = memoryStorage();
  const prefs = new Map<string, string>();
  let deviceSeq = 0;
  let current: AuthSession | null = session();
  let clock = 1_000_000;
  const post = opts.post ?? jest.fn(async () => ({ device: { deviceId: `d${++deviceSeq}` } }));
  const del = opts.del ?? jest.fn(async (_path: string, _opts?: DeleteOpts) => undefined);
  const log = jest.fn();
  const api = { post, delete: del } as unknown as ApiClient;
  const push = new PushService({
    adapter,
    api,
    storage,
    preferences: { get: async (k) => prefs.get(k) ?? null, set: async (k, v) => void (v === null ? prefs.delete(k) : prefs.set(k, v)) },
    getSession: () => current,
    tokenFor: (s) => (s as unknown as { idToken: string }).idToken,
    now: () => clock,
    log,
  });
  return {
    push,
    adapter,
    storage,
    prefs,
    post,
    del,
    log,
    setSession: (s: AuthSession | null) => {
      current = s;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const stored = async (storage: ReturnType<typeof memoryStorage>, key = 'bm.push.device') => JSON.parse((await storage.getItem(key)) ?? 'null') as Record<string, string> | null;
const GRANTED = { permission: { status: 'granted', canAskAgain: true } } as const;

describe('PushService - izin ve kayit', () => {
  it('izin hic sorulmadiysa: giriste yalnizca uygulama ici aciklama, sistem istemi ve kayit yok', async () => {
    const { push, adapter, post } = setup();
    await push.onSignedIn(session());
    expect(push.getSnapshot().promptVisible).toBe(true);
    expect(adapter.state.requests).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  it('"izin ver": sistem istemi, kayit (token, platform, surum, dil) ve deviceId guvenli depoda', async () => {
    const { push, adapter, post, storage } = setup();
    await push.onSignedIn(session());
    await push.accept();
    expect(adapter.state.requests).toBe(1);
    expect(post).toHaveBeenCalledWith('/api/me/devices', { token: expoTokenOf('aaaaaaaaaaaa'), platform: 'android', appVersion: '0.1.0', locale: 'tr-TR' }, expect.anything());
    expect(await stored(storage)).toEqual({ userId: 'u1', deviceId: 'd1', token: expoTokenOf('aaaaaaaaaaaa') });
    expect(push.getSnapshot()).toMatchObject({ registered: true, promptVisible: false, permission: 'granted' });
  });

  it('izin reddedilirse kayit yok; "Şimdi değil" kullaniciya bir daha sorulmaz, baska kullaniciya sorulur', async () => {
    const denied = setup({ afterRequest: { status: 'denied', canAskAgain: false } });
    await denied.push.onSignedIn(session());
    await denied.push.accept();
    expect(denied.post).not.toHaveBeenCalled();
    expect(denied.push.getSnapshot()).toMatchObject({ permission: 'denied', canAskAgain: false, registered: false });

    const later = setup();
    await later.push.onSignedIn(session());
    await later.push.dismiss();
    await later.push.onSignedIn(session());
    expect(later.push.getSnapshot().promptVisible).toBe(false);
    later.setSession(session('u2'));
    await later.push.onSignedIn(session('u2'));
    expect(later.push.getSnapshot().promptVisible).toBe(true);
  });

  it('EAS projectId yoksa kayit ve istem atlanir, bir kez loglanir', async () => {
    const { push, post, log, adapter } = setup({ projectId: undefined, ...GRANTED });
    await push.onSignedIn(session());
    await push.onSignedIn(session());
    await push.accept();
    expect(post).not.toHaveBeenCalled();
    expect(adapter.state.requests).toBe(0);
    expect(push.getSnapshot()).toMatchObject({ support: 'no_project', promptVisible: false });
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('PushService - token olaylari', () => {
  it('native modul her token alisinda olay yayar: kayit dongusu olusmaz', async () => {
    const { push, post, adapter } = setup(GRANTED);
    await push.onSignedIn(session());
    await flush(10);
    await push.sync();
    await flush(10);
    expect(post).toHaveBeenCalledTimes(1);
    // Ayni degerdeki olay (ornek: baska bir token alisi) yeniden kayit baslatmaz.
    adapter.changeToken('aaaaaaaaaaaa');
    await flush(10);
    expect(post).toHaveBeenCalledTimes(1);
    expect(adapter.state.tokenFetches).toBe(1);
  });

  it('yeni cihaz token: tek yeniden kayit, eski deviceId silinir', async () => {
    const { push, post, adapter, del } = setup(GRANTED);
    await push.onSignedIn(session());
    adapter.changeToken('bbbbbbbbbbbb');
    await flush(10);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith('/api/me/devices', expect.objectContaining({ token: expoTokenOf('bbbbbbbbbbbb') }), expect.anything());
    expect(del).toHaveBeenCalledWith('/api/me/devices/d1');
  });

  it('acilista ayni kullanici + token: POST yok; token degistiyse yeni kayit ve eski silinir', async () => {
    const same = setup(GRANTED);
    await same.storage.setItem('bm.push.device', JSON.stringify({ userId: 'u1', deviceId: 'old', token: expoTokenOf('aaaaaaaaaaaa') }));
    await same.push.onRestored(session());
    expect(same.post).not.toHaveBeenCalled();
    expect(same.push.getSnapshot().registered).toBe(true);

    const changed = setup({ ...GRANTED, device: 'cccccccccccc' });
    await changed.storage.setItem('bm.push.device', JSON.stringify({ userId: 'u1', deviceId: 'old', token: expoTokenOf('aaaaaaaaaaaa') }));
    await changed.push.onRestored(session());
    expect(changed.post).toHaveBeenCalledTimes(1);
    expect(changed.del).toHaveBeenCalledWith('/api/me/devices/old');
  });

  it('acilista izin yoksa hicbir sey yapilmaz (istem acilista gosterilmez)', async () => {
    const { push, post } = setup();
    await push.onRestored(session());
    expect(post).not.toHaveBeenCalled();
    expect(push.getSnapshot().promptVisible).toBe(false);
  });
});

describe('PushService - cikis', () => {
  it('cikis: DELETE giden oturumun token\'iyla (oturum kapansa da), yerel kayit temizlenir', async () => {
    const { push, del, storage, setSession } = setup(GRANTED);
    await push.onSignedIn(session());
    const done = push.beginSignOut(session());
    setSession(null);
    await done;
    expect(del).toHaveBeenCalledWith('/api/me/devices/d1', { auth: false, headers: { authorization: 'Bearer tok-u1' } });
    expect(await stored(storage)).toBeNull();
    expect(push.getSnapshot().registered).toBe(false);
  });

  it('kayit surerken cikis: kayit biter, kuyruktaki silme yeni cihazi giden token\'la siler; oturum kayitli sayilmaz', async () => {
    let resolvePost: (v: unknown) => void = () => undefined;
    const post = jest.fn(() => new Promise((r) => (resolvePost = r)));
    const { push, del, storage, setSession } = setup(GRANTED, { post });
    const signIn = push.onSignedIn(session());
    await flush();
    expect(post).toHaveBeenCalledTimes(1);
    const out = push.beginSignOut(session());
    setSession(null);
    resolvePost({ device: { deviceId: 'd-late' } });
    await signIn;
    await out;
    expect(del).toHaveBeenCalledWith('/api/me/devices/d-late', { auth: false, headers: { authorization: 'Bearer tok-u1' } });
    expect(await stored(storage)).toBeNull();
    expect(push.getSnapshot().registered).toBe(false);
  });

  it('cikis baslamadan kuyrukta bekleyen kayit hic yapilmaz', async () => {
    const { push, post, setSession } = setup(GRANTED);
    const signIn = push.onSignedIn(session());
    const out = push.beginSignOut(session());
    setSession(null);
    await signIn;
    await out;
    expect(post).not.toHaveBeenCalled();
  });

  it('ayni cihazda kullanici degisimi: A silinir (A token\'i), B kendi oturumuyla kaydolur', async () => {
    const { push, post, del, storage, setSession } = setup(GRANTED);
    await push.onSignedIn(session('uA'));
    const out = push.beginSignOut(session('uA'));
    setSession(null);
    await out;
    push.onSessionChange(session('uA'), null);
    setSession(session('uB'));
    push.onSessionChange(null, session('uB'));
    await push.onSignedIn(session('uB'));
    expect(del).toHaveBeenCalledWith('/api/me/devices/d1', { auth: false, headers: { authorization: 'Bearer tok-uA' } });
    expect(post).toHaveBeenCalledTimes(2);
    expect(await stored(storage)).toEqual({ userId: 'uB', deviceId: 'd2', token: expoTokenOf('aaaaaaaaaaaa') });
    expect(push.getSnapshot().registered).toBe(true);
  });

  it('cevrimdisi cikis: cihaz push kaydi iptal edilir, silme ayni kullanicinin sonraki girisinde yeniden denenir', async () => {
    const del = jest.fn(async (): Promise<undefined> => {
      throw new NetworkError(new Error('offline'));
    });
    const { push, adapter, storage, setSession } = setup(GRANTED, { del });
    await push.onSignedIn(session());
    const out = push.beginSignOut(session());
    setSession(null);
    await out;
    expect(adapter.state.unregistered).toBe(1);
    expect(await stored(storage)).toBeNull();
    expect(await stored(storage, 'bm.push.revoke')).toEqual({ userId: 'u1', deviceId: 'd1' });

    del.mockImplementation(async () => undefined);
    setSession(session());
    await push.onSignedIn(session());
    expect(del).toHaveBeenLastCalledWith('/api/me/devices/d1');
    expect(await stored(storage, 'bm.push.revoke')).toBeNull();
  });

  it('bekleyen silme baska kullanicinin girisinde denenmez, birakilir (token zaten gecersiz)', async () => {
    const { push, storage, del, setSession } = setup(GRANTED);
    await storage.setItem('bm.push.revoke', JSON.stringify({ userId: 'uA', deviceId: 'dA' }));
    setSession(session('uB'));
    await push.onSignedIn(session('uB'));
    expect(del).not.toHaveBeenCalledWith('/api/me/devices/dA');
    expect(await stored(storage, 'bm.push.revoke')).toBeNull();
  });

  it('401 ile dusen oturum: izin aciklamasi kapanir, sonraki kullanicinin "Şimdi değil"i gecerli', async () => {
    const { push, setSession } = setup();
    setSession(session('uA'));
    await push.onSignedIn(session('uA'));
    expect(push.getSnapshot().promptVisible).toBe(true);
    setSession(null);
    push.onSessionChange(session('uA'), null);
    expect(push.getSnapshot().promptVisible).toBe(false);
    setSession(session('uB'));
    await push.dismiss();
    await push.onSignedIn(session('uB'));
    expect(push.getSnapshot().promptVisible).toBe(false);
  });
});

describe('PushService - hata ve gosterim', () => {
  it('429: hata yok, Hesabım icin mesaj; one gelmede 6 saat denenmez, sonra denenir', async () => {
    const post = jest.fn(async () => {
      throw new ApiError(429, { error: 'rate_limited', message: 'Çok fazla' });
    });
    const { push, advance } = setup(GRANTED, { post });
    await expect(push.onSignedIn(session())).resolves.toBeUndefined();
    expect(push.getSnapshot()).toMatchObject({ registered: false });
    expect(push.getSnapshot().error).toMatch(/kaydedilemedi/);
    await push.sync();
    expect(post).toHaveBeenCalledTimes(1);
    advance(RETRY_BACKOFF_MS + 1);
    await push.sync();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('on plan: oturum yokken veya bilinmeyen apartmanda gosterilmez', async () => {
    const { push, setSession } = setup(GRANTED);
    await push.onSignedIn(session('u1', 'apt-1'));
    push.setKnownApartments(['apt-1', 'apt-2']);
    expect(push.shouldShow({ url: '/borclar', apartmentId: 'apt-1' })).toBe(true);
    expect(push.shouldShow({ url: '/borclar', apartmentId: 'apt-2' })).toBe(true);
    expect(push.shouldShow({ url: '/borclar' })).toBe(true);
    expect(push.shouldShow({ url: '/borclar', apartmentId: 'apt-9' })).toBe(false);
    setSession(null);
    push.onSessionChange(session('u1'), null);
    expect(push.shouldShow({ url: '/borclar', apartmentId: 'apt-1' })).toBe(false);
  });
});

describe('oturum kancalari (createServices)', () => {
  it('giriste POST /api/me/devices, cikista (giden token\'la) DELETE', async () => {
    const api = mockApi({ 'POST /api/me/devices': { status: 201, body: { device: { deviceId: 'dev-9' } } }, 'DELETE /api/me/devices/dev-9': { device: { deviceId: 'dev-9' } } });
    const notifications = fakeNotifications(GRANTED);
    const services = createServices(TEST_ENV, { adapter: createMockAuthAdapter({ storage: memoryStorage(), delayMs: 0 }), fetchImpl: api.fetchImpl, notifications, pushStorage: memoryStorage() });
    await services.session.ready;
    await services.session.signIn({ email: 'resident@dev.local', password: 'Mock123456' });
    await flush(10);
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/me/devices')?.body).toMatchObject({ token: expoTokenOf('aaaaaaaaaaaa'), platform: 'android' });

    const idToken = services.session.getSession()?.idToken;
    await services.session.signOut();
    const removal = api.calls.find((c) => c.method === 'DELETE' && c.path === '/api/me/devices/dev-9');
    expect(api.authOf(removal)).toBe(`Bearer ${idToken}`);
    expect(services.session.getSession()).toBeNull();
  });
});
