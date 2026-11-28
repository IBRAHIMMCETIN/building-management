import type { BiometricAdapter, BiometricResult, BiometricStatus } from '@/lib/lock/types';

/** Varsayilan (jest.setup.ts): biyometri yok; Hesabım'daki kilit anahtari etkisiz. */
export const noBiometrics: BiometricAdapter = {
  status: async () => ({ hardware: false, enrolled: false, kind: null }),
  authenticate: async () => ({ ok: false, error: 'not_available' }),
};

export type FakeBiometrics = BiometricAdapter & {
  state: BiometricStatus & { results: BiometricResult[]; prompts: string[] };
};

/** Testin surdugu sahte: cihaz durumu ve sirayla donen dogrulama sonuclari (bossa basarili). */
export function fakeBiometrics(initial: Partial<BiometricStatus> = {}): FakeBiometrics {
  const state = { hardware: true, enrolled: true, kind: 'face' as BiometricStatus['kind'], ...initial, results: [] as BiometricResult[], prompts: [] as string[] };
  return {
    state,
    status: async () => ({ hardware: state.hardware, enrolled: state.enrolled, kind: state.kind }),
    authenticate: async (prompt) => {
      state.prompts.push(prompt);
      return state.results.shift() ?? { ok: true };
    },
  };
}
