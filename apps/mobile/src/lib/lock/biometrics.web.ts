import type { BiometricAdapter } from './types';

/** Web onizlemesi: biyometrik kilit yok (Hesabım'da secenek gosterilmez). */
export const biometrics: BiometricAdapter = {
  status: async () => ({ hardware: false, enrolled: false, kind: null }),
  authenticate: async () => ({ ok: false, error: 'not_available' }),
};
