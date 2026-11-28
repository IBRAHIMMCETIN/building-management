import { fakeBiometrics } from '@/test/biometrics';
import { AppLockService, DEFAULT_LOCK_TIMEOUT_MINUTES, type LockStorage, lockStorageKey } from './appLock';

function memory(initial: Record<string, string> = {}): LockStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void (v === null ? data.delete(k) : data.set(k, v)),
  };
}

const on = (timeoutMinutes = DEFAULT_LOCK_TIMEOUT_MINUTES) => JSON.stringify({ enabled: true, timeoutMinutes });
const MIN = 60_000;

function setup(opts: { stored?: Record<string, string>; bio?: Parameters<typeof fakeBiometrics>[0] } = {}) {
  let now = 1_000_000;
  const storage = memory(opts.stored);
  const bio = fakeBiometrics(opts.bio);
  const onAutoDisabled = jest.fn();
  const lock = new AppLockService({ biometrics: bio, storage, now: () => now, onAutoDisabled });
  return { lock, storage, bio, onAutoDisabled, advance: (ms: number) => void (now += ms) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('AppLockService', () => {
  it('acik kilit: soguk acilista kilitli; dogrulama basariliysa acilir', async () => {
    const { lock, bio } = setup({ stored: { [lockStorageKey('u1')]: on() } });
    const restoring = lock.onRestored('u1');
    expect(lock.getState().status).toBe('checking');
    await restoring;
    expect(lock.getState().status).toBe('locked');
    expect(await lock.unlock()).toBe(true);
    expect(lock.getState().status).toBe('unlocked');
    expect(bio.state.prompts).toEqual(['YÖNESİST kilidini açın']);
  });

  it('kapali kilit (varsayilan): soguk acilista kilit yok, istem acilmaz', async () => {
    const { lock, bio } = setup();
    await lock.onRestored('u1');
    expect(lock.getState()).toMatchObject({ status: 'unlocked', settings: { enabled: false, timeoutMinutes: 5 } });
    expect(bio.state.prompts).toEqual([]);
  });

  it('etkilesimli giris kilitsiz baslar (sifreyle dogrulandi), tercih okunur', async () => {
    const { lock } = setup({ stored: { [lockStorageKey('u1')]: on(15) } });
    await lock.onSignedIn('u1');
    expect(lock.getState()).toMatchObject({ status: 'unlocked', settings: { enabled: true, timeoutMinutes: 15 } });
  });

  it('kayitli biyometri yoksa kilit kendiliginden kapanir ve bildirilir', async () => {
    const { lock, storage, onAutoDisabled } = setup({ stored: { [lockStorageKey('u1')]: on() }, bio: { enrolled: false } });
    await lock.onRestored('u1');
    expect(lock.getState().status).toBe('unlocked');
    expect(JSON.parse(storage.data.get(lockStorageKey('u1')) ?? '{}')).toEqual({ enabled: false, timeoutMinutes: 5 });
    expect(onAutoDisabled).toHaveBeenCalledTimes(1);
  });

  it('arka planda sure dolmadan donus kilitlemez; sure dolunca kilitler', async () => {
    const { lock, advance } = setup({ stored: { [lockStorageKey('u1')]: on(5) } });
    await lock.onSignedIn('u1');
    lock.onAppState('background');
    advance(4 * MIN);
    lock.onAppState('active');
    await flush();
    expect(lock.getState().status).toBe('unlocked');

    lock.onAppState('background');
    advance(5 * MIN);
    lock.onAppState('active');
    await flush();
    expect(lock.getState().status).toBe('locked');
  });

  it('iOS inactive (Face ID / kontrol merkezi) arka plan sayilmaz', async () => {
    const { lock, advance } = setup({ stored: { [lockStorageKey('u1')]: on(1) } });
    await lock.onSignedIn('u1');
    lock.onAppState('inactive');
    advance(10 * MIN);
    lock.onAppState('active');
    await flush();
    expect(lock.getState().status).toBe('unlocked');
  });

  it('dogrulama sirasinda arka plana gecis (Android cihaz sifresi ekrani) sayilmaz', async () => {
    const { lock, bio, advance } = setup({ stored: { [lockStorageKey('u1')]: on(1) } });
    await lock.onRestored('u1');
    let resolve: (v: { ok: true }) => void = () => undefined;
    bio.authenticate = () => new Promise((r) => (resolve = r));
    const unlocking = lock.unlock();
    lock.onAppState('background');
    advance(2 * MIN);
    resolve({ ok: true });
    await unlocking;
    lock.onAppState('active');
    await flush();
    expect(lock.getState().status).toBe('unlocked');
  });

  it('vazgecme / basarisiz deneme kilitli kalir, Turkce mesaj; tekrar deneme acar', async () => {
    const { lock, bio } = setup({ stored: { [lockStorageKey('u1')]: on() } });
    await lock.onRestored('u1');
    bio.state.results.push({ ok: false, error: 'user_cancel' }, { ok: false, error: 'lockout' });
    expect(await lock.unlock()).toBe(false);
    expect(lock.getState()).toMatchObject({ status: 'locked', error: expect.stringContaining('iptal edildi') });
    expect(await lock.unlock()).toBe(false);
    expect(lock.getState().error).toMatch(/Çok fazla başarısız deneme/);
    expect(await lock.unlock()).toBe(true);
    expect(lock.getState()).toMatchObject({ status: 'unlocked', error: null });
  });

  it('kilitliyken kayitli biyometri kaldirildiysa (not_enrolled) kilit kapanir', async () => {
    const { lock, bio, storage } = setup({ stored: { [lockStorageKey('u1')]: on() } });
    await lock.onRestored('u1');
    bio.state.results.push({ ok: false, error: 'not_enrolled' });
    bio.state.enrolled = false;
    expect(await lock.unlock()).toBe(true);
    expect(lock.getState().status).toBe('unlocked');
    expect(JSON.parse(storage.data.get(lockStorageKey('u1')) ?? '{}').enabled).toBe(false);
  });

  it('kullanici basina: A kilitli, B ayni cihazda kilitsiz; cikis temizler', async () => {
    const { lock, advance } = setup({ stored: { [lockStorageKey('a')]: on(1) } });
    await lock.onSignedIn('a');
    lock.clear();
    expect(lock.getState()).toMatchObject({ status: 'unlocked', userId: null });
    await lock.onSignedIn('b');
    lock.onAppState('background');
    advance(30 * MIN);
    lock.onAppState('active');
    await flush();
    expect(lock.getState()).toMatchObject({ status: 'unlocked', userId: 'b', settings: { enabled: false } });
  });

  it('kullanici degisince eski kullanicinin gec gelen sonucu yok sayilir', async () => {
    const storage = memory({ [lockStorageKey('a')]: on() });
    let release: () => void = () => undefined;
    const slow: LockStorage = { get: (k) => new Promise((r) => (release = () => void storage.get(k).then(r))), set: storage.set };
    const lock = new AppLockService({ biometrics: fakeBiometrics(), storage: slow });
    const restoring = lock.onRestored('a');
    lock.clear();
    release();
    await restoring;
    expect(lock.getState()).toMatchObject({ status: 'unlocked', userId: null });
  });

  it('acma: once dogrulama; basarisizsa kaydedilmez; kayitli biyometri yoksa neden', async () => {
    const { lock, bio, storage } = setup({ bio: { enrolled: false } });
    await lock.onSignedIn('u1');
    expect(await lock.setEnabled(true)).toEqual({ ok: false, message: 'Cihazda kayıtlı Face ID / parmak izi yok. Önce cihaz ayarlarından ekleyin.' });
    bio.state.enrolled = true;
    bio.state.results.push({ ok: false, error: 'user_cancel' });
    expect(await lock.setEnabled(true)).toMatchObject({ ok: false });
    expect(storage.data.size).toBe(0);
    expect(await lock.setEnabled(true)).toEqual({ ok: true });
    expect(lock.getState().settings.enabled).toBe(true);
    await lock.setTimeoutMinutes(15);
    await lock.setTimeoutMinutes(7); // listede yok: yok sayilir
    // Depoda yalnizca tercih var (kimlik bilgisi / token yok).
    expect([...storage.data.entries()]).toEqual([[lockStorageKey('u1'), JSON.stringify({ enabled: true, timeoutMinutes: 15 })]]);
    expect(await lock.setEnabled(false)).toEqual({ ok: true });
    expect(lock.getState().settings.enabled).toBe(false);
  });

  it('donanim yoksa acilamaz; Hesabım tazelemesi acik kilidi kullanilamiyorsa kapatir', async () => {
    const { lock, bio, onAutoDisabled } = setup({ stored: { [lockStorageKey('u1')]: on() }, bio: { hardware: false, enrolled: false } });
    await lock.onSignedIn('u1');
    expect(await lock.refreshBiometric()).toEqual({ hardware: false, enrolled: false, kind: 'face' });
    expect(lock.getState().settings.enabled).toBe(false);
    expect(onAutoDisabled).toHaveBeenCalled();
    expect(await lock.setEnabled(true)).toEqual({ ok: false, message: 'Bu cihazda Face ID / parmak izi doğrulaması yok.' });
    expect(bio.state.prompts).toEqual([]);
  });

  it('bozuk / eski tercih varsayilana duser', async () => {
    const { lock } = setup({ stored: { [lockStorageKey('u1')]: '{bozuk', [lockStorageKey('u2')]: JSON.stringify({ enabled: true, timeoutMinutes: 99 }) } });
    await lock.onSignedIn('u1');
    expect(lock.getState().settings).toEqual({ enabled: false, timeoutMinutes: 5 });
    await lock.onSignedIn('u2');
    expect(lock.getState().settings).toEqual({ enabled: true, timeoutMinutes: 5 });
  });
});

describe('AppLockService: istem dongusu, gizlilik ortusu, hatalar', () => {
  it('vazgecildikten sonra istemin kendi inactive -> active gecisi yeni istem acmaz', async () => {
    const { lock, bio, advance } = setup({ stored: { [lockStorageKey('u1')]: on() } });
    await lock.onRestored('u1');
    bio.state.results.push({ ok: false, error: 'user_cancel' });
    await lock.unlock();
    lock.onAppState('inactive');
    lock.onAppState('active');
    // Android: cihaz sifresi ekrani uygulamayi arka plana alir; istem bittikten hemen sonra donus.
    lock.onAppState('background');
    advance(300);
    lock.onAppState('active');
    await flush();
    expect(bio.state.prompts).toHaveLength(1);
    expect(lock.getState()).toMatchObject({ status: 'locked', error: expect.stringContaining('iptal edildi') });
  });

  it('kilitliyken gercek arka plan -> on plan gecisi (1 sn sonra) istemi yeniden acar', async () => {
    const { lock, bio, advance } = setup({ stored: { [lockStorageKey('u1')]: on() } });
    await lock.onRestored('u1');
    bio.state.results.push({ ok: false, error: 'user_cancel' });
    await lock.unlock();
    lock.onAppState('background');
    advance(60_000);
    lock.onAppState('active');
    await flush();
    expect(bio.state.prompts).toHaveLength(2);
    expect(lock.getState().status).toBe('unlocked');
  });

  it('gizlilik ortusu: kilit aciksa inactive / background ortulur, kisa donuste kalkar; kilit kapaliysa ortu yok', async () => {
    const { lock, advance } = setup({ stored: { [lockStorageKey('u1')]: on(5) } });
    await lock.onSignedIn('u1');
    lock.onAppState('inactive');
    expect(lock.getState().covered).toBe(true);
    lock.onAppState('background');
    advance(MIN);
    lock.onAppState('active');
    expect(lock.getState()).toMatchObject({ covered: false, status: 'unlocked' });

    const off = setup();
    await off.lock.onSignedIn('u2');
    off.lock.onAppState('inactive');
    expect(off.lock.getState().covered).toBe(false);
  });

  it('gizlilik ortusu kilit karari verilene kadar kalir (sure dolunca kilit)', async () => {
    const { lock, bio, advance } = setup({ stored: { [lockStorageKey('u1')]: on(1) } });
    await lock.onSignedIn('u1');
    let release: () => void = () => undefined;
    const status = bio.status;
    bio.status = () => new Promise((r) => (release = () => void status().then(r)));
    lock.onAppState('background');
    advance(2 * MIN);
    lock.onAppState('active');
    expect(lock.getState()).toMatchObject({ status: 'checking', covered: true });
    release();
    await flush();
    await flush();
    expect(lock.getState()).toMatchObject({ status: 'locked', covered: false });
  });

  it('istem sirasinda (Hesabım acma) ortu acilmaz', async () => {
    const { lock, bio } = setup({ stored: { [lockStorageKey('u1')]: on() } });
    await lock.onSignedIn('u1');
    let resolve: (v: { ok: true }) => void = () => undefined;
    bio.authenticate = () => new Promise((r) => (resolve = r));
    await lock.setEnabled(false);
    const enabling = lock.setEnabled(true);
    await flush();
    lock.onAppState('inactive');
    expect(lock.getState().covered).toBe(false);
    resolve({ ok: true });
    await enabling;
  });

  it('saat geri alindiysa (negatif sure) suresi dolmus sayilir', async () => {
    const { lock, advance } = setup({ stored: { [lockStorageKey('u1')]: on(15) } });
    await lock.onSignedIn('u1');
    lock.onAppState('background');
    advance(-10 * MIN);
    lock.onAppState('active');
    await flush();
    expect(lock.getState().status).toBe('locked');
  });

  it('cihaz durumu okunamazsa kilit acik kalir ve kapatilmaz (cihaz sifresiyle acilir)', async () => {
    const { lock, storage, onAutoDisabled } = setup({ stored: { [lockStorageKey('u1')]: on() }, bio: { hardware: false, enrolled: false, error: true } });
    await lock.onRestored('u1');
    expect(lock.getState().status).toBe('locked');
    expect(onAutoDisabled).not.toHaveBeenCalled();
    expect(JSON.parse(storage.data.get(lockStorageKey('u1')) ?? '{}').enabled).toBe(true);
    await lock.refreshBiometric();
    expect(lock.getState().settings.enabled).toBe(true);
  });

  it('gecici istem hatasi (unknown / not_available ama cihaz durumu tamam) kilidi kapatmaz', async () => {
    const { lock, bio, storage } = setup({ stored: { [lockStorageKey('u1')]: on() } });
    await lock.onRestored('u1');
    bio.state.results.push({ ok: false, error: 'unknown' }, { ok: false, error: 'not_available' });
    expect(await lock.unlock()).toBe(false);
    expect(await lock.unlock()).toBe(false);
    expect(lock.getState()).toMatchObject({ status: 'locked', error: expect.stringContaining('cihaz şifrenizi') });
    expect(JSON.parse(storage.data.get(lockStorageKey('u1')) ?? '{}').enabled).toBe(true);
  });

  it('guvenli depo okunamazsa: "acik" isareti varsa kilitli (fail locked), yoksa kilitsiz', async () => {
    const failing: LockStorage = { get: async () => Promise.reject(new Error('keychain')), set: async () => undefined };
    const marker = memory({ [lockStorageKey('u1')]: '1' });
    const locked = new AppLockService({ biometrics: fakeBiometrics(), storage: failing, marker });
    await locked.onRestored('u1');
    expect(locked.getState().status).toBe('locked');

    const unknown = new AppLockService({ biometrics: fakeBiometrics(), storage: failing, marker: memory() });
    await unknown.onRestored('u1');
    expect(unknown.getState().status).toBe('unlocked');
  });

  it('asil kayit kaybolsa da "acik" isareti kilidi acik tutar; kapatma ikisini de siler', async () => {
    const storage = memory();
    const marker = memory({ [lockStorageKey('u1')]: '1' });
    const lock = new AppLockService({ biometrics: fakeBiometrics(), storage, marker });
    await lock.onRestored('u1');
    expect(lock.getState().status).toBe('locked');
    await lock.unlock();
    await lock.setEnabled(false);
    expect(marker.data.size).toBe(0);
    expect(JSON.parse(storage.data.get(lockStorageKey('u1')) ?? '{}').enabled).toBe(false);
    await lock.setEnabled(true);
    expect(marker.data.get(lockStorageKey('u1'))).toBe('1');
  });
});
