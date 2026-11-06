/**
 * Modullerden bagimsiz HTTP hatalari (http/helpers.ts bunlari eslestirir).
 * Bu dosya hicbir modulu import etmez; dongusel bagimlilik olusmaz.
 */

/** Kimligi dogrulanmis kullanicinin bu islemi yapma yetkisi yok -> 403. */
export class AccessDeniedError extends Error {
  constructor(message = 'Bu islem icin yetkiniz yok') {
    super(message);
    this.name = 'AccessDeniedError';
  }
}
