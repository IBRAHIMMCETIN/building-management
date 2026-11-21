import { type FakePaymentProvider, createFakePaymentProvider } from './fakeProvider.js';
import { IYZICO_BASE_URLS, createIyzicoClient } from './iyzico/client.js';
import { createIyzicoProvider } from './iyzico/provider.js';
import { PAYTR_BASE_URL, createPaytrClient } from './paytr/client.js';
import { createPaytrProvider } from './paytr/provider.js';
import { KMSClient } from '@aws-sdk/client-kms';
import { type PayeeVault, createKmsPayeeVault, createLocalPayeeVault } from './payee.js';
import type { PaymentProvider } from './provider.js';
import { EMPTY_REGISTRY, type ProviderRegistry, createProviderRegistry, isProviderName } from './registry.js';
import { envCredentials, envPaytrCredentials, secretsManagerCredentials, secretsManagerPaytrCredentials } from './secrets.js';
import type { PaymentProviderName } from './types.js';

/**
 * Ortam degiskenleri (Online Odeme v2 · P2: birden fazla saglayici):
 *   PAYMENTS_PROVIDERS        acik saglayicilar, virgulle: `iyzico`, `paytr`, `fake` (yerel).
 *                             Bos/`disabled`: online odeme kapali. Eski tekil `PAYMENTS_PROVIDER`
 *                             da okunur (PAYMENTS_PROVIDERS yoksa).
 *   DEFAULT_PAYMENT_PROVIDER  apartman tercihi yoksa kullanilan saglayici; acik saglayicilardan
 *                             biri olmali. Tek saglayici aciksa verilmeyebilir.
 *   PAYMENTS_API_BASE_URL     API'nin disaridan adresi (callback), ornegin http://localhost:3000
 *   WEB_APP_URL               odeme sonrasi donus, ornegin https://building-management-apx.pages.dev
 *   PAYMENTS_INTENT_TTL_MINUTES  saglayici sayfasinin gecerliligi (varsayilan 30)
 * iyzico icin ek olarak:
 *   IYZICO_BASE_URL           https://sandbox-api.iyzipay.com | https://api.iyzipay.com
 *   IYZICO_SECRET_ARN         Secrets Manager (Lambda); eski ad PAYMENTS_SECRET_ARN da okunur -- veya --
 *   IYZICO_API_KEY / IYZICO_SECRET_KEY (yalnizca yerel gelistirme)
 * PayTR icin ek olarak (P3):
 *   PAYTR_SECRET_ARN          Secrets Manager: {"merchantId","merchantKey","merchantSalt"} -- veya --
 *   PAYTR_MERCHANT_ID / PAYTR_MERCHANT_KEY / PAYTR_MERCHANT_SALT (yalnizca yerel gelistirme)
 *   PAYTR_TEST_MODE           `1` (varsayilan; test islemi) | `0` (canli). Canli magaza panelde
 *                             test modundan cikarilmis olmalidir.
 *   PAYTR_TRANSFER_DELAY_HOURS  odeme onayindan sonra Platform Transfer bekleme suresi (0-720, vars. 24)
 * P4 (aktarim alicisi ve platform faturasi):
 *   PAYEE_KMS_KEY_ID          IBAN + hesap sahibi adini sifreleyen KMS anahtari (ARN). Yoksa yerel
 *                             gelistirmede bellek ici anahtar; production'da alici saklanamaz.
 *   PLATFORM_INVOICE_MODE     `monthly` (varsayilan) | `per_payment`
 *   PLATFORM_INVOICE_VAT_BPS  KDV orani, baz puan (varsayilan 2000 = %20)
 *   PLATFORM_INVOICE_VAT_MODE `exclusive` (varsayilan; platform payi + KDV) | `inclusive`
 * Yanlis yapilandirma soguk baslangicta hata verir; sessizce calismaz. Anahtarin kendisi ilk
 * istekte okunur (soguk baslangicta Secrets Manager cagrisi yapilmaz).
 */
export type InvoiceSettings = {
  mode: 'monthly' | 'per_payment';
  vatRateBasisPoints: number;
  vatMode: 'exclusive' | 'inclusive';
};

export type PaymentsRuntimeConfig = {
  /** Acik saglayicilar + varsayilan (online odeme kapaliysa bos kayit). */
  providers: ProviderRegistry;
  /** Aktarim alicisi kasasi (KMS); yoksa alici saklanamaz. */
  vault?: PayeeVault;
  invoices: InvoiceSettings;
  fake?: FakePaymentProvider;
  apiBaseUrl: string;
  webAppUrl: string;
  intentTtlMinutes: number;
};

function requireUrl(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} ortam degiskeni tanimli degil (online odeme acik)`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} gecerli bir URL degil`);
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`${key} https olmali`);
  }
  return value.replace(/\/+$/, '');
}

/** `PAYMENTS_PROVIDERS` (veya eski `PAYMENTS_PROVIDER`) -> sirali, tekil ad listesi. */
export function enabledProviderNames(env: NodeJS.ProcessEnv): PaymentProviderName[] {
  const raw = (env.PAYMENTS_PROVIDERS ?? env.PAYMENTS_PROVIDER ?? '').trim();
  if (raw === '' || raw === 'disabled') return [];
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const out: PaymentProviderName[] = [];
  for (const n of names) {
    if (!isProviderName(n)) throw new Error(`Bilinmeyen odeme saglayicisi: ${n}`);
    if (out.includes(n)) throw new Error(`Odeme saglayicisi iki kez verildi: ${n}`);
    out.push(n);
  }
  return out;
}

type FactoryContext = { env: NodeJS.ProcessEnv; apiBaseUrl: string };

/**
 * Saglayici fabrikalari. Yeni saglayici (P3: PayTR) yalnizca buraya bir fabrika ekleyerek
 * acilir; servis, rotalar ve mutabakat saglayicidan bagimsizdir.
 */
const FACTORIES: Record<PaymentProviderName, (ctx: FactoryContext) => PaymentProvider> = {
  fake: ({ env, apiBaseUrl }) => {
    if (env.NODE_ENV === 'production') throw new Error('fake odeme saglayicisi production ortaminda kullanilamaz');
    return createFakePaymentProvider({ apiBaseUrl });
  },
  iyzico: ({ env }) => {
    const baseUrl = (env.IYZICO_BASE_URL ?? '').trim().replace(/\/+$/, '');
    if (baseUrl !== IYZICO_BASE_URLS.sandbox && baseUrl !== IYZICO_BASE_URLS.live) {
      throw new Error(`IYZICO_BASE_URL ${IYZICO_BASE_URLS.sandbox} veya ${IYZICO_BASE_URLS.live} olmali`);
    }
    const secretArn = (env.IYZICO_SECRET_ARN ?? env.PAYMENTS_SECRET_ARN)?.trim();
    const credentials = secretArn ? secretsManagerCredentials(secretArn) : envCredentials(env);
    return createIyzicoProvider({
      client: createIyzicoClient({ baseUrl, credentials }),
      sandbox: baseUrl === IYZICO_BASE_URLS.sandbox,
    });
  },
  paytr: ({ env }) => {
    const mode = (env.PAYTR_TEST_MODE ?? '1').trim();
    if (mode !== '0' && mode !== '1') throw new Error('PAYTR_TEST_MODE 0 veya 1 olmali');
    const secretArn = env.PAYTR_SECRET_ARN?.trim();
    const credentials = secretArn ? secretsManagerPaytrCredentials(secretArn) : envPaytrCredentials(env);
    const delay = Number(env.PAYTR_TRANSFER_DELAY_HOURS ?? 24);
    if (!Number.isInteger(delay) || delay < 0 || delay > 720) throw new Error('PAYTR_TRANSFER_DELAY_HOURS 0-720 tam sayi olmali');
    return createPaytrProvider({ client: createPaytrClient({ baseUrl: PAYTR_BASE_URL, credentials }), testMode: mode === '1', transferDelayHours: delay });
  },
};

export function loadPaymentsConfig(env: NodeJS.ProcessEnv = process.env): PaymentsRuntimeConfig {
  const ttl = Number(env.PAYMENTS_INTENT_TTL_MINUTES ?? 30);
  if (!Number.isInteger(ttl) || ttl < 5 || ttl > 120) throw new Error('PAYMENTS_INTENT_TTL_MINUTES 5-120 olmali');

  const invoices = loadInvoiceSettings(env);
  const names = enabledProviderNames(env);
  const defaultRaw = env.DEFAULT_PAYMENT_PROVIDER?.trim() || undefined;
  if (names.length === 0) {
    if (defaultRaw) throw new Error('DEFAULT_PAYMENT_PROVIDER verilmis ama acik saglayici yok (PAYMENTS_PROVIDERS)');
    return { providers: EMPTY_REGISTRY, invoices, apiBaseUrl: 'http://localhost:3000', webAppUrl: 'http://localhost:5173', intentTtlMinutes: ttl };
  }
  if (defaultRaw !== undefined && !isProviderName(defaultRaw)) throw new Error(`Bilinmeyen DEFAULT_PAYMENT_PROVIDER: ${defaultRaw}`);
  if (defaultRaw !== undefined && !names.includes(defaultRaw)) {
    throw new Error(`DEFAULT_PAYMENT_PROVIDER (${defaultRaw}) PAYMENTS_PROVIDERS icinde olmali`);
  }
  if (defaultRaw === undefined && names.length > 1) {
    throw new Error('Birden fazla saglayici acikken DEFAULT_PAYMENT_PROVIDER zorunludur');
  }

  const apiBaseUrl = requireUrl(env, 'PAYMENTS_API_BASE_URL');
  const webAppUrl = requireUrl(env, 'WEB_APP_URL');
  const ctx: FactoryContext = { env, apiBaseUrl };
  const providers = names.map((n) => FACTORIES[n](ctx));
  const fake = providers.find((p): p is FakePaymentProvider => p.name === 'fake');
  return {
    providers: createProviderRegistry(providers, defaultRaw as PaymentProviderName | undefined),
    ...(fake ? { fake } : {}),
    ...vaultOf(env),
    invoices,
    apiBaseUrl,
    webAppUrl,
    intentTtlMinutes: ttl,
  };
}

function vaultOf(env: NodeJS.ProcessEnv): { vault?: PayeeVault } {
  const vault = loadVault(env);
  return vault ? { vault } : {};
}

/** KMS anahtari varsa KMS kasasi; yoksa yalnizca production disinda bellek ici kasa. */
let localVault: PayeeVault | undefined;
export function loadVault(env: NodeJS.ProcessEnv): PayeeVault | undefined {
  const keyId = env.PAYEE_KMS_KEY_ID?.trim();
  if (keyId) {
    if (!/^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:(key|alias)\/[A-Za-z0-9/_-]+$/.test(keyId)) throw new Error('PAYEE_KMS_KEY_ID gecerli bir KMS anahtar/alias ARN olmali');
    return createKmsPayeeVault({ keyId, client: new KMSClient({}) });
  }
  if (env.NODE_ENV === 'production') return undefined;
  localVault ??= createLocalPayeeVault();
  return localVault;
}

export function loadInvoiceSettings(env: NodeJS.ProcessEnv): InvoiceSettings {
  const mode = (env.PLATFORM_INVOICE_MODE ?? 'monthly').trim();
  if (mode !== 'monthly' && mode !== 'per_payment') throw new Error('PLATFORM_INVOICE_MODE monthly veya per_payment olmali');
  const vatMode = (env.PLATFORM_INVOICE_VAT_MODE ?? 'exclusive').trim();
  if (vatMode !== 'exclusive' && vatMode !== 'inclusive') throw new Error('PLATFORM_INVOICE_VAT_MODE exclusive veya inclusive olmali');
  const vat = Number(env.PLATFORM_INVOICE_VAT_BPS ?? 2000);
  if (!Number.isInteger(vat) || vat < 0 || vat > 5000) throw new Error('PLATFORM_INVOICE_VAT_BPS 0-5000 tam sayi olmali');
  return { mode, vatRateBasisPoints: vat, vatMode };
}
