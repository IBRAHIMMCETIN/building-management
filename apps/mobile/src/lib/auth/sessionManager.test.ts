import { AuthRequiredError } from '@bm/shared/api/errors';
import { AuthFlowError } from '@bm/shared/auth/errors';
import type { KeyValueStorage } from '../storage/types';
import { createMockAuthAdapter } from './mockAdapter';
import { SessionManager } from './sessionManager';

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    setItem: async (k, v) => void data.set(k, v),
    getItem: async (k) => data.get(k) ?? null,
    removeItem: async (k) => void data.delete(k),
    clear: async () => data.clear(),
  };
}

const setup = (storage = memoryStorage()) => {
  const adapter = createMockAuthAdapter({ storage, delayMs: 0 });
  const manager = new SessionManager(adapter, 'id');
  return { storage, adapter, manager };
};

describe('SessionManager + mock adapter (web mockAdapter ile ayni senaryolar)', () => {
  it('acilista oturum yoksa hazir ve bos', async () => {
    const { manager } = setup();
    expect(manager.getState().status).toBe('initializing');
    await manager.ready;
    expect(manager.getState()).toEqual({ status: 'ready', session: null });
    expect(await manager.getApiToken()).toBeNull();
  });

  it('tek apartmanli rol dogrudan baglamla girer; oturum depodan geri yuklenir', async () => {
    const { manager, storage } = setup();
    await manager.ready;
    const step = await manager.signIn({ email: 'resident@dev.local', password: 'x' });
    expect(step.type).toBe('done');
    expect(manager.getSession()?.claims).toMatchObject({ role: 'resident', apartmentId: 'apt-dev-1' });
    expect(await manager.getApiToken()).toMatch(/^mock\./);

    const again = setup(storage).manager;
    await again.ready;
    expect(again.getSession()?.claims.email).toBe('resident@dev.local');
  });

  it("coklu apartmanda rol claim'i olmadan girer, secimle baglam alir", async () => {
    const { manager } = setup();
    await manager.ready;
    await manager.signIn({ email: 'multi@dev.local', password: 'x' });
    expect(manager.getSession()?.claims.role).toBeUndefined();
    const next = await manager.setActiveContext({ apartmentId: 'apt-dev-2', role: 'resident' });
    expect(next.claims).toMatchObject({ role: 'resident', apartmentId: 'apt-dev-2' });
  });

  it('yetkisiz baglam secimi reddedilir (claim eslesmez)', async () => {
    const { manager } = setup();
    await manager.ready;
    await manager.signIn({ email: 'multi@dev.local', password: 'x' });
    await expect(manager.setActiveContext({ apartmentId: 'apt-dev-2', role: 'apartment_manager' })).rejects.toThrow('doğrulanamadı');
  });

  it('gecici sifre -> yeni sifre -> MFA -> giris; yanlis kod Turkce hata', async () => {
    const { manager } = setup();
    await manager.ready;
    expect(await manager.signIn({ email: 'yeni+mfa@dev.local', password: 'Gecici12345' })).toEqual({ type: 'newPasswordRequired' });
    expect(await manager.confirmNewPassword('YeniSifre123')).toEqual({ type: 'totpRequired' });
    await expect(manager.confirmTotp('000000')).rejects.toBeInstanceOf(AuthFlowError);
    await expect(manager.confirmTotp('000000')).rejects.toThrow('Kod hatalı');
    const done = await manager.confirmTotp('123456');
    expect(done.type).toBe('done');
    expect(manager.getSession()?.claims.role).toBe('resident');
  });

  it('sifre belirlendikten sonra gecici sifre tekrar ilk giris sayilmaz', async () => {
    const { manager } = setup();
    await manager.ready;
    await manager.signIn({ email: 'b@dev.local', password: 'Gecici12345' });
    await manager.confirmNewPassword('YeniSifre123');
    await manager.signOut();
    expect((await manager.signIn({ email: 'b@dev.local', password: 'Gecici12345' })).type).toBe('done');
  });

  it('cikis oturumu ve saklanan bilgiyi siler', async () => {
    const { manager, storage } = setup();
    await manager.ready;
    await manager.signIn({ email: 'resident@dev.local', password: 'x' });
    await manager.signOut();
    expect(manager.getSession()).toBeNull();
    expect(storage.data.has('bm.mock-session')).toBe(false);
  });

  it('sure dolmak uzereyse token yenilenir; yenileme basarisizsa oturum duser', async () => {
    const storage = memoryStorage();
    const adapter = createMockAuthAdapter({ storage, delayMs: 0 });
    const refresh = jest.spyOn(adapter, 'refresh');
    const manager = new SessionManager(adapter, 'access');
    await manager.ready;
    await manager.signIn({ email: 'resident@dev.local', password: 'x' });
    await manager.getApiToken({ forceRefresh: true });
    expect(refresh).toHaveBeenCalledTimes(1);

    refresh.mockRejectedValueOnce(new Error('ag'));
    await expect(manager.getApiToken({ forceRefresh: true })).rejects.toBeInstanceOf(AuthRequiredError);
    expect(manager.getSession()).toBeNull();
    expect(manager.consumeExpiredNotice()).toBe('unauthorized');
    expect(manager.consumeExpiredNotice()).toBeNull();
  });

  it('ayni anda gelen yenilemeler tek cagriyi paylasir', async () => {
    const { manager, adapter } = setup();
    await manager.ready;
    await manager.signIn({ email: 'resident@dev.local', password: 'x' });
    const refresh = jest.spyOn(adapter, 'refresh');
    await Promise.all([manager.refresh(), manager.refresh(), manager.refresh()]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('yasam dongusu kancalari: giristen sonra ve cikistan once (token hala gecerli)', async () => {
    const { manager } = setup();
    await manager.ready;
    const events: string[] = [];
    manager.setHooks({
      afterSignIn: (s) => void events.push(`giris:${s.claims.email}`),
      beforeSignOut: async () => {
        events.push(`cikis:${(await manager.getApiToken()) ? 'token-var' : 'token-yok'}`);
      },
    });
    await manager.signIn({ email: 'resident@dev.local', password: 'x' });
    await new Promise((r) => setTimeout(r, 0));
    await manager.signOut();
    expect(events).toEqual(['giris:resident@dev.local', 'cikis:token-var']);
    expect(manager.getSession()).toBeNull();
  });

  it('kanca hatasi / gecikmesi giris ve cikisi engellemez; geri yuklemede kanca calismaz', async () => {
    const storage = memoryStorage();
    // Cikis kancasi hic bitmez: en fazla 20 ms beklenir.
    const first = new SessionManager(createMockAuthAdapter({ storage, delayMs: 0 }), 'id', 20);
    first.setHooks({ afterSignIn: () => Promise.reject(new Error('ag')), beforeSignOut: () => new Promise(() => undefined) });
    await first.ready;
    expect((await first.signIn({ email: 'resident@dev.local', password: 'x' })).type).toBe('done');

    const afterSignIn = jest.fn();
    const restored = new SessionManager(createMockAuthAdapter({ storage, delayMs: 0 }), 'id');
    restored.setHooks({ afterSignIn });
    await restored.ready;
    expect(restored.getSession()).not.toBeNull();
    expect(afterSignIn).not.toHaveBeenCalled();

    await first.signOut();
    expect(first.getSession()).toBeNull();
  });

  it('abone durum degisikliklerini alir', async () => {
    const { manager } = setup();
    const listener = jest.fn();
    manager.subscribe(listener);
    await manager.ready;
    await manager.signIn({ email: 'resident@dev.local', password: 'x' });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
