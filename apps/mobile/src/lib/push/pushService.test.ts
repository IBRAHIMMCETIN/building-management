import { ApiError } from '@bm/shared/api/errors';
import type { AuthSession } from '@bm/shared/auth/session';
import type { ApiClient } from '@/lib/api/createApiClient';
import { createMockAuthAdapter } from '@/lib/auth/mockAdapter';
import { createServices } from '@/services';
import { fakeNotifications } from '@/test/notifications';
import { TEST_ENV, memoryStorage, mockApi } from '@/test/renderApp';
import { PushService } from './pushService';

/* Push kayit yasam dongusu: izin, EAS projesi, token degisimi, cikis, 429. */

const session = (sub = 'u1') => ({ claims: { sub } }) as unknown as AuthSession;

function setup(init: Parameters<typeof fakeNotifications>[0] = {}, opts: { current?: AuthSession | null; post?: jest.Mock } = {}) {
  const adapter = fakeNotifications(init);
  const storage = memoryStorage();
  const prefs = new Map<string, string>();
  let deviceSeq = 0;
  const post = opts.post ?? jest.fn(async () => ({ device: { deviceId: `d${++deviceSeq}` } }));
  const del = jest.fn(async () => undefined);
  const log = jest.fn();
  const api = { post, delete: del } as unknown as ApiClient;
  const current = opts.current === undefined ? session() : opts.current;
  const push = new PushService({
    adapter,
    api,
    storage,
    preferences: { get: async (k) => prefs.get(k) ?? null, set: async (k, v) => void (v === null ? prefs.delete(k) : prefs.set(k, v)) },
    getSession: () => current,
    log,
  });
  return { push, adapter, storage, prefs, post, del, log };
}

const stored = async (storage: ReturnType<typeof memoryStorage>) => JSON.parse((await storage.getItem('bm.push.device')) ?? 'null') as { deviceId: string; token: string; userId: string } | null;

describe('PushService', () => {
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
    expect(post).toHaveBeenCalledWith('/api/me/devices', { token: 'ExponentPushToken[aaaaaaaaaaaa]', platform: 'android', appVersion: '0.1.0', locale: 'tr-TR' }, expect.anything());
    expect(await stored(storage)).toEqual({ userId: 'u1', deviceId: 'd1', token: 'ExponentPushToken[aaaaaaaaaaaa]' });
    expect(push.getSnapshot()).toMatchObject({ registered: true, promptVisible: false, permission: 'granted' });
  });

  it('izin reddedilirse kayit yok; "Şimdi değil" kullaniciya bir daha sorulmaz', async () => {
    const denied = setup({ afterRequest: { status: 'denied', canAskAgain: false } });
    await denied.push.accept();
    expect(denied.post).not.toHaveBeenCalled();
    expect(denied.push.getSnapshot()).toMatchObject({ permission: 'denied', canAskAgain: false, registered: false });

    const later = setup();
    await later.push.onSignedIn(session());
    await later.push.dismiss();
    expect(later.push.getSnapshot().promptVisible).toBe(false);
    await later.push.onSignedIn(session());
    expect(later.push.getSnapshot().promptVisible).toBe(false);
    // Baska kullanici icin yeniden sorulur.
    await later.push.onSignedIn(session('u2'));
    expect(later.push.getSnapshot().promptVisible).toBe(true);
  });

  it('izin onceden verildiyse giriste sessizce kaydolunur', async () => {
    const { push, post, adapter } = setup({ permission: { status: 'granted', canAskAgain: true } });
    await push.onSignedIn(session());
    expect(post).toHaveBeenCalledTimes(1);
    expect(adapter.state.requests).toBe(0);
    expect(push.getSnapshot().promptVisible).toBe(false);
  });

  it('EAS projectId yoksa kayit ve istem atlanir, bir kez loglanir', async () => {
    const { push, post, log, adapter } = setup({ projectId: undefined, permission: { status: 'granted', canAskAgain: true } });
    await push.onSignedIn(session());
    await push.onSignedIn(session());
    await push.accept();
    expect(post).not.toHaveBeenCalled();
    expect(adapter.state.requests).toBe(0);
    expect(push.getSnapshot()).toMatchObject({ support: 'no_project', promptVisible: false });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/projectId/);
  });

  it('acilista ayni token: POST yok; token degistiyse yeni kayit ve eski deviceId silinir', async () => {
    const same = setup({ permission: { status: 'granted', canAskAgain: true }, token: 'ExponentPushToken[t1]' });
    await same.storage.setItem('bm.push.device', JSON.stringify({ userId: 'u1', deviceId: 'old', token: 'ExponentPushToken[t1]' }));
    await same.push.onRestored(session());
    expect(same.post).not.toHaveBeenCalled();
    expect(same.push.getSnapshot().registered).toBe(true);

    const changed = setup({ permission: { status: 'granted', canAskAgain: true }, token: 'ExponentPushToken[t2]' });
    await changed.storage.setItem('bm.push.device', JSON.stringify({ userId: 'u1', deviceId: 'old', token: 'ExponentPushToken[t1]' }));
    await changed.push.onRestored(session());
    expect(changed.post).toHaveBeenCalledWith('/api/me/devices', expect.objectContaining({ token: 'ExponentPushToken[t2]' }), expect.anything());
    expect(changed.del).toHaveBeenCalledWith('/api/me/devices/old');
    expect((await stored(changed.storage))?.deviceId).toBe('d1');
  });

  it('acilista izin yoksa hicbir sey yapilmaz (istem acilista gosterilmez)', async () => {
    const { push, post } = setup();
    await push.onRestored(session());
    expect(post).not.toHaveBeenCalled();
    expect(push.getSnapshot().promptVisible).toBe(false);
  });

  it('uygulama acikken cihaz token degisimi yeniden kaydeder', async () => {
    const { push, post, adapter, del } = setup({ permission: { status: 'granted', canAskAgain: true } });
    await push.onSignedIn(session());
    adapter.changeToken('ExponentPushToken[bbbbbbbbbbbb]');
    await new Promise((r) => setTimeout(r, 10));
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith('/api/me/devices', expect.objectContaining({ token: 'ExponentPushToken[bbbbbbbbbbbb]' }), expect.anything());
    expect(del).toHaveBeenCalledWith('/api/me/devices/d1');
  });

  it('cikis: sunucudaki kayit silinir, yerel kayit temizlenir; 404 sessiz', async () => {
    const { push, del, storage, log } = setup({ permission: { status: 'granted', canAskAgain: true } });
    await push.onSignedIn(session());
    del.mockRejectedValueOnce(new ApiError(404, { error: 'not_found' }));
    await push.unregister();
    expect(del).toHaveBeenCalledWith('/api/me/devices/d1');
    expect(await stored(storage)).toBeNull();
    expect(push.getSnapshot().registered).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('429 (gunluk kayit siniri) zararsiz: hata yok, kayitsiz kalir', async () => {
    const post = jest.fn(async () => {
      throw new ApiError(429, { error: 'rate_limited', message: 'Çok fazla' });
    });
    const { push, log } = setup({ permission: { status: 'granted', canAskAgain: true } }, { post });
    await expect(push.onSignedIn(session())).resolves.toBeUndefined();
    expect(push.getSnapshot()).toMatchObject({ registered: false });
    expect(push.getSnapshot().error).toBeUndefined();
    expect(log.mock.calls[0]?.[0]).toMatch(/429/);
  });
});

describe('oturum kancalari (createServices)', () => {
  it('giriste POST /api/me/devices, cikista (token gecerliyken) DELETE', async () => {
    const api = mockApi({ 'POST /api/me/devices': { status: 201, body: { device: { deviceId: 'dev-9' } } }, 'DELETE /api/me/devices/dev-9': { device: { deviceId: 'dev-9' } } });
    const notifications = fakeNotifications({ permission: { status: 'granted', canAskAgain: true } });
    const services = createServices(TEST_ENV, { adapter: createMockAuthAdapter({ storage: memoryStorage(), delayMs: 0 }), fetchImpl: api.fetchImpl, notifications, pushStorage: memoryStorage() });
    await services.session.ready;
    await services.session.signIn({ email: 'resident@dev.local', password: 'Mock123456' });
    await new Promise((r) => setTimeout(r, 10));
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/me/devices')?.body).toMatchObject({ token: 'ExponentPushToken[aaaaaaaaaaaa]', platform: 'android' });

    await services.session.signOut();
    expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/me/devices/dev-9')).toBe(true);
    expect(services.session.getSession()).toBeNull();
  });
});
