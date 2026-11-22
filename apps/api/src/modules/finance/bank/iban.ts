/**
 * Banka hareketlerinde karsi taraf IBAN'i: ayiklama, maskeleme ve HMAC ozeti.
 *
 *  - Duz metin IBAN hicbir kayda, loga veya yanita yazilmaz. Aciklamadaki her IBAN benzeri dizi
 *    maskelenir (`TR** **** ... **12 34`).
 *  - Eslestirme (B2: "bu IBAN daha once A-12 ile eslesti") icin yalnizca anahtarli ozet saklanir:
 *    KMS `GenerateMac` (HMAC_SHA_256, musteri yonetimli HMAC_256 anahtari). Anahtar KMS'ten
 *    cikmaz; ozetten IBAN'a donulemez ve anahtarsiz sozluk saldirisi yapilamaz.
 *  - Ozet girdisi apartman kimligini icerir (`bank-iban:v1|<apt>|<IBAN>`): ayni IBAN farkli
 *    apartmanlarda farkli ozet uretir, apartmanlar arasi iliskilendirme yapilamaz.
 *  - Onek surumu: `k1:` (KMS) / `l1:` (yerel, deterministik). Farkli kaynaklarin ozetleri karismaz.
 */
import { createHmac } from 'node:crypto';
import { GenerateMacCommand, KMSClient } from '@aws-sdk/client-kms';
import { isValidTrIban, maskIban, normalizeIban } from '../../payments/payee.js';
import { BankError } from './errors.js';

export { isValidTrIban, maskIban, normalizeIban };

/** "TR12 0006 1005 ..." gibi bosluklu yazimlari da yakalar (TR + 24 hane). */
const IBAN_LIKE = /\bTR(?:[\s-]?\d){24}\b/gi;

export type IbanExtraction = {
  /** IBAN'lari maskelenmis metin. */
  text: string;
  /** Metindeki ilk GECERLI (mod-97) TR IBAN'i (normalize). Yalnizca bellekte kullanilir. */
  iban?: string;
};

/** Metindeki IBAN'lari maskeler; ilk gecerli olani dondurur. */
export function extractIban(text: string): IbanExtraction {
  let first: string | undefined;
  const masked = text.replace(IBAN_LIKE, (m) => {
    const iban = normalizeIban(m.replace(/-/g, ''));
    if (!first && isValidTrIban(iban)) first = iban;
    return maskIban(iban);
  });
  return { text: masked, ...(first ? { iban: first } : {}) };
}

// ---------------------------------------------------------------------------
// HMAC
// ---------------------------------------------------------------------------

export const IBAN_MAC_ALGORITHM = 'HMAC_SHA_256';
const macMessage = (apartmentId: string, iban: string) => `bank-iban:v1|${apartmentId}|${normalizeIban(iban)}`;

export type IbanMacer = {
  readonly kind: 'kms' | 'local';
  mac(apartmentId: string, iban: string): Promise<string>;
};

export function createKmsIbanMacer(options: { keyId: string; client: Pick<KMSClient, 'send'> }): IbanMacer {
  const { keyId, client } = options;
  return {
    kind: 'kms',
    async mac(apartmentId, iban) {
      let out: { Mac?: Uint8Array } | undefined;
      try {
        out = await client.send(
          new GenerateMacCommand({
            KeyId: keyId,
            MacAlgorithm: IBAN_MAC_ALGORITHM,
            Message: Buffer.from(macMessage(apartmentId, iban), 'utf8'),
          }),
        );
      } catch (err) {
        const name = err instanceof Error ? err.name : 'unknown';
        throw new BankError('unavailable', `IBAN ozeti uretilemedi (${name})`, undefined, { cause: err });
      }
      if (!out?.Mac || out.Mac.byteLength === 0) throw new BankError('unavailable', 'IBAN ozeti uretilemedi (bos yanit)');
      return `k1:${Buffer.from(out.Mac).toString('base64url')}`;
    },
  };
}

/**
 * Yerel gelistirme ve testler: deterministik HMAC (anahtar `BANK_IBAN_MAC_LOCAL_KEY` veya sabit
 * gelistirme anahtari). Production'da kullanilamaz (loadIbanMacer).
 */
export function createLocalIbanMacer(key = 'bm-local-bank-iban-mac-v1'): IbanMacer {
  return {
    kind: 'local',
    async mac(apartmentId, iban) {
      return `l1:${createHmac('sha256', key).update(macMessage(apartmentId, iban), 'utf8').digest('base64url')}`;
    },
  };
}

const KMS_KEY_ARN = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:(key|alias)\/[A-Za-z0-9/_-]+$/;

/**
 * `BANK_IBAN_MAC_KEY_ID` (KMS anahtar/alias ARN) varsa KMS; yoksa production disinda yerel HMAC.
 * Production'da anahtar yoksa `undefined`: ekstre uclari 503 doner (IBAN ozetsiz satir yazilmaz).
 */
export function loadIbanMacer(env: NodeJS.ProcessEnv = process.env, kmsClient?: () => Pick<KMSClient, 'send'>): IbanMacer | undefined {
  const keyId = env.BANK_IBAN_MAC_KEY_ID?.trim();
  if (keyId) {
    if (!KMS_KEY_ARN.test(keyId)) throw new Error('BANK_IBAN_MAC_KEY_ID gecerli bir KMS anahtar/alias ARN olmali');
    return createKmsIbanMacer({ keyId, client: kmsClient ? kmsClient() : new KMSClient({}) });
  }
  const isProd = env.NODE_ENV === 'production' || Boolean(env.AWS_LAMBDA_FUNCTION_NAME);
  if (isProd) return undefined;
  return createLocalIbanMacer(env.BANK_IBAN_MAC_LOCAL_KEY?.trim() || undefined);
}

/** Ayni istekte ayni IBAN icin tek KMS cagrisi; en fazla `concurrency` es zamanli cagri. */
export async function macAll(macer: IbanMacer, apartmentId: string, ibans: string[], concurrency = 8): Promise<Map<string, string>> {
  const unique = [...new Set(ibans.map(normalizeIban))];
  const out = new Map<string, string>();
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const iban = unique[next++] as string;
      out.set(iban, await macer.mac(apartmentId, iban));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  return out;
}
