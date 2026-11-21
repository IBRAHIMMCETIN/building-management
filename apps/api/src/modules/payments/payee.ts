/**
 * Online Odeme v2 · P4: apartmanin aktarim alicisi (IBAN + hesap sahibi adi) ve sifreli saklama.
 *
 *  - Alici bilgisi DynamoDB'de yalnizca AWS KMS ile sifreli (`payeeCiphertext`) durur; API
 *    yanitlarinda ve loglarda yalnizca maskeli IBAN (`TR** ... **12 34`) gorunur.
 *  - Sifreleme baglami (EncryptionContext) `{ purpose, apartmentId, provider }`: sifreli metin baska
 *    bir apartmanin/saglayicinin kaydina kopyalanirsa cozulemez. IAM politikalari da `purpose`
 *    baglamina kosulludur.
 *  - Yetki ayrimi: API Lambda yalnizca SIFRELER (`kms:Encrypt`); cozme (`kms:Decrypt`) yalnizca
 *    transfer talimatini gonderen zamanlanmis worker'dadir. Cozulmus IBAN bellekte, yalnizca
 *    talimat aninda bulunur.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { DecryptCommand, EncryptCommand, type KMSClient } from '@aws-sdk/client-kms';
import { PaymentProviderError } from './provider.js';

export type Payee = { iban: string; name: string };

export const PAYEE_PURPOSE = 'payment-payee';

export type PayeeContext = { apartmentId: string; provider: string };

/** Alici sifreleme kasasi. `seal` API'de, `open` yalnizca transfer gonderen worker'da kullanilir. */
export type PayeeVault = {
  seal(ctx: PayeeContext, payee: Payee): Promise<string>;
  open(ctx: PayeeContext, ciphertext: string): Promise<Payee>;
};

// ---------------------------------------------------------------------------
// IBAN ve ad
// ---------------------------------------------------------------------------

export const normalizeIban = (value: string) => value.replace(/\s/g, '').toUpperCase();

/** TR IBAN: `TR` + 24 hane (2 kontrol + 5 banka + 1 rezerv + 16 hesap), ISO 13616 mod-97 = 1. */
export function isValidTrIban(value: string): boolean {
  const iban = normalizeIban(value);
  if (!/^TR\d{24}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rem = 0;
  for (const d of numeric) rem = (rem * 10 + Number(d)) % 97;
  return rem === 1;
}

/** Yalnizca son 4 hane: "TR** **** **** **** **** **12 34". */
export function maskIban(value: string): string {
  const last4 = normalizeIban(value).slice(-4);
  return `TR** **** **** **** **** **${last4.slice(0, 2)} ${last4.slice(2)}`;
}

/** Maskeli IBAN'in son 4 hanesi (geri donen aktarim eslemesi icin). */
export const ibanLast4 = (value: string) => normalizeIban(value).replace(/\D/g, '').slice(-4);

/** Hesap sahibi adi: bosluklar tekillesir; 2-140 karakter (bankanin hesap unvani). */
export function normalizePayeeName(value: string): string | undefined {
  const s = value.replace(/\s+/g, ' ').trim();
  return s.length >= 2 && s.length <= 140 ? s : undefined;
}

function parsePayee(raw: string): Payee {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw new PaymentProviderError('payee_corrupt', 'Alici bilgisi cozulemedi');
  }
  const p = o as Record<string, unknown>;
  if (typeof p?.iban !== 'string' || typeof p.name !== 'string' || !isValidTrIban(p.iban)) {
    throw new PaymentProviderError('payee_corrupt', 'Alici bilgisi gecersiz');
  }
  return { iban: p.iban, name: p.name };
}

const encryptionContext = (ctx: PayeeContext) => ({ purpose: PAYEE_PURPOSE, apartmentId: ctx.apartmentId, provider: ctx.provider });

// ---------------------------------------------------------------------------
// KMS (Lambda)
// ---------------------------------------------------------------------------

export function createKmsPayeeVault(options: { keyId: string; client: Pick<KMSClient, 'send'> }): PayeeVault {
  const { keyId, client } = options;
  const failure = (err: unknown, op: string): never => {
    const name = err instanceof Error ? err.name : 'unknown';
    // Erisim/anahtar hatalari kalici; diger hatalar (kisitlama, ag) tekrar denenebilir.
    const permanent = ['AccessDeniedException', 'NotFoundException', 'DisabledException', 'InvalidCiphertextException', 'IncorrectKeyException', 'KMSInvalidStateException'].includes(name);
    throw new PaymentProviderError(`kms_${op}_failed`, `Alici bilgisi ${op === 'encrypt' ? 'sifrelenemedi' : 'cozulemedi'} (${name})`, !permanent);
  };
  return {
    async seal(ctx, payee) {
      try {
        const out = await client.send(
          new EncryptCommand({ KeyId: keyId, Plaintext: Buffer.from(JSON.stringify(payee), 'utf8'), EncryptionContext: encryptionContext(ctx) }),
        );
        if (!out.CiphertextBlob) throw new Error('bos sifreli metin');
        return Buffer.from(out.CiphertextBlob).toString('base64');
      } catch (err) {
        return failure(err, 'encrypt');
      }
    },
    async open(ctx, ciphertext) {
      let plain: Uint8Array | undefined;
      try {
        const out = await client.send(
          new DecryptCommand({ KeyId: keyId, CiphertextBlob: Buffer.from(ciphertext, 'base64'), EncryptionContext: encryptionContext(ctx) }),
        );
        plain = out.Plaintext;
      } catch (err) {
        return failure(err, 'decrypt');
      }
      if (!plain) throw new PaymentProviderError('kms_decrypt_failed', 'Alici bilgisi cozulemedi');
      return parsePayee(Buffer.from(plain).toString('utf8'));
    },
  };
}

// ---------------------------------------------------------------------------
// Yerel gelistirme / test: bellek ici AES-256-GCM (anahtar surec icinde rastgele)
// ---------------------------------------------------------------------------

/**
 * KMS olmayan yerel ortam ve testler icin. Anahtar surec omru kadar yasar (yeniden baslatmada
 * eski kayitlar cozulemez); production'da kullanilamaz (config.ts). Baglam AAD olarak baglanir.
 */
export function createLocalPayeeVault(key: Buffer = randomBytes(32)): PayeeVault {
  const aad = (ctx: PayeeContext) => Buffer.from(JSON.stringify(encryptionContext(ctx)), 'utf8');
  return {
    async seal(ctx, payee) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(aad(ctx));
      const body = Buffer.concat([c.update(JSON.stringify(payee), 'utf8'), c.final()]);
      return `local:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
    },
    async open(ctx, ciphertext) {
      if (!ciphertext.startsWith('local:')) throw new PaymentProviderError('payee_corrupt', 'Alici bilgisi bu ortamda cozulemez');
      const raw = Buffer.from(ciphertext.slice(6), 'base64');
      try {
        const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        d.setAAD(aad(ctx));
        d.setAuthTag(raw.subarray(12, 28));
        return parsePayee(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
      } catch (err) {
        if (err instanceof PaymentProviderError) throw err;
        throw new PaymentProviderError('payee_corrupt', 'Alici bilgisi cozulemedi');
      }
    },
  };
}
