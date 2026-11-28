import * as LocalAuthentication from 'expo-local-authentication';
import type { BiometricAdapter, BiometricStatus } from './types';

const NONE: BiometricStatus = { hardware: false, enrolled: false, kind: null };

/**
 * expo-local-authentication: iOS Face ID / Touch ID, Android BiometricPrompt. Cihaz sifresine dusus
 * acik (`disableDeviceFallback: false`): biyometri birkac kez tutmazsa sistem cihaz sifresini sorar.
 * Hata veya desteklenmeyen ortamda "yok" doner (kilit acilmaz / kendiliginden kapanir).
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
      return NONE;
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
