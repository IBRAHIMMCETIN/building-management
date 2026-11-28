import * as LocalAuthentication from 'expo-local-authentication';
import type { BiometricAdapter, BiometricStatus } from './types';

/** Durum okunamadi: "kayitli biyometri yok" ile karistirilmaz (kilit kapatilmaz, cihaz sifresi kalir). */
const UNKNOWN: BiometricStatus = { hardware: false, enrolled: false, kind: null, error: true };

/**
 * expo-local-authentication: iOS Face ID / Touch ID, Android BiometricPrompt. Cihaz sifresine dusus
 * acik (`disableDeviceFallback: false`): biyometri birkac kez tutmazsa sistem cihaz sifresini sorar.
 * Modul hatasinda durum `error: true` doner; kilit karari bunu "yok" saymaz.
 */
export const biometrics: BiometricAdapter = {
  async status() {
    try {
      const [hardware, enrolled, types] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
        LocalAuthentication.supportedAuthenticationTypesAsync(),
      ]);
      const T = LocalAuthentication.AuthenticationType;
      const kind = types.includes(T.FACIAL_RECOGNITION) ? 'face' : types.includes(T.FINGERPRINT) ? 'fingerprint' : types.includes(T.IRIS) ? 'iris' : null;
      return { hardware, enrolled, kind };
    } catch {
      return UNKNOWN;
    }
  },
  async authenticate(promptMessage) {
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage,
        cancelLabel: 'Vazgeç',
        fallbackLabel: 'Cihaz şifresini kullan',
        disableDeviceFallback: false,
      });
      return result.success ? { ok: true } : { ok: false, error: result.error };
    } catch {
      return { ok: false, error: 'unknown' };
    }
  },
};
