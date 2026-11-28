import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { lockStorageKey } from '@/lib/lock/appLock';
import { fakeBiometrics } from '@/test/biometrics';
import { renderApp } from '@/test/renderApp';
import { AppLockCard } from './AppLockCard';

const lockSwitch = () => screen.getByRole('switch', { name: 'Face ID / parmak izi ile kilit' });

describe('Hesabım > Uygulama kilidi', () => {
  it('kayitli biyometri yoksa anahtar devre disi ve nedeni yazar', async () => {
    await renderApp(<AppLockCard />, { biometrics: fakeBiometrics({ enrolled: false }) });
    expect(await screen.findByText('Cihazda kayıtlı Face ID / parmak izi yok. Önce cihaz ayarlarından ekleyin.')).toBeTruthy();
    expect(lockSwitch().props.disabled).toBe(true);
  });

  it('acmak once dogrulama ister; basarida sure secenekleri (varsayilan 5 dk) gorunur ve kaydedilir', async () => {
    const bio = fakeBiometrics();
    const { services } = await renderApp(<AppLockCard />, { biometrics: bio });
    await waitFor(() => expect(lockSwitch().props.disabled).toBe(false));
    await fireEvent(lockSwitch(), 'valueChange', true);
    await waitFor(() => expect(lockSwitch().props.value).toBe(true));
    expect(bio.state.prompts).toEqual(['Uygulama kilidini açmak için doğrulayın']);
    expect(screen.getByRole('radio', { name: '5 dk', checked: true })).toBeTruthy();
    await fireEvent.press(screen.getByRole('radio', { name: '15 dk' }));
    await waitFor(() => expect(services.lock.getState().settings).toEqual({ enabled: true, timeoutMinutes: 15 }));
    const sub = services.session.getSession()?.claims.sub ?? '';
    expect(lockStorageKey(sub)).toMatch(/^appLock\.v1:/);
  });

  it('dogrulama tamamlanmazsa acilmaz ve mesaj gosterir', async () => {
    const bio = fakeBiometrics();
    bio.state.results.push({ ok: false, error: 'user_cancel' });
    const { services } = await renderApp(<AppLockCard />, { biometrics: bio });
    await waitFor(() => expect(lockSwitch().props.disabled).toBe(false));
    await fireEvent(lockSwitch(), 'valueChange', true);
    expect(await screen.findByText('Uygulama kilidi etkinleştirilmedi: doğrulama tamamlanmadı.')).toBeTruthy();
    expect(lockSwitch().props.value).toBe(false);
    expect(services.lock.getState().settings.enabled).toBe(false);
  });

  it('kapatmak dogrulama istemez', async () => {
    const bio = fakeBiometrics();
    const { services } = await renderApp(<AppLockCard />, { biometrics: bio });
    await waitFor(() => expect(lockSwitch().props.disabled).toBe(false));
    await fireEvent(lockSwitch(), 'valueChange', true);
    await waitFor(() => expect(lockSwitch().props.value).toBe(true));
    await fireEvent(lockSwitch(), 'valueChange', false);
    await waitFor(() => expect(services.lock.getState().settings.enabled).toBe(false));
    expect(bio.state.prompts).toHaveLength(1);
    expect(screen.queryByRole('radio', { name: '5 dk' })).toBeNull();
  });
});
