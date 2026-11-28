/** Cihazin biyometrik dogrulama durumu (expo-local-authentication). */
export type BiometricStatus = {
  /** Yuz / parmak izi okuyucusu var. */
  hardware: boolean;
  /** Cihazda kayitli yuz / parmak izi var. */
  enrolled: boolean;
  /** Kayitli turlerden ilki (etiket icin): yuz, parmak izi, iris. */
  kind: 'face' | 'fingerprint' | 'iris' | null;
};

export type BiometricResult = { ok: true } | { ok: false; error: string };

/**
 * Biyometrik dogrulama katmani. Uygulama kimlik bilgisi saklamaz ve gondermez: yalnizca cihazin
 * "sahibi mi" sorusunu sistem istemine sorar (Face ID / Touch ID / parmak izi; basarisizsa cihaz sifresi).
 */
export type BiometricAdapter = {
  status(): Promise<BiometricStatus>;
  authenticate(promptMessage: string): Promise<BiometricResult>;
};
