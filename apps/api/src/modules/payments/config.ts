import { type FakePaymentProvider, createFakePaymentProvider } from './fakeProvider.js';
import { IYZICO_BASE_URLS, createIyzicoClient } from './iyzico/client.js';
import { createIyzicoProvider } from './iyzico/provider.js';
import type { PaymentProvider } from './provider.js';
import { EMPTY_REGISTRY, type ProviderRegistry, createProviderRegistry, isProviderName } from './registry.js';
import { envCredentials, secretsManagerCredentials } from './secrets.js';
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
 * Yanlis yapilandirma soguk baslangicta hata verir; sessizce calismaz. Anahtarin kendisi ilk
 * istekte okunur (soguk baslangicta Secrets Manager cagrisi yapilmaz).
 */
export type PaymentsRuntimeConfig = {
  /** Acik saglayicilar + varsayilan (online odeme kapaliysa bos kayit). */
  providers: ProviderRegistry;
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
  paytr: () => {
    throw new Error('PayTR adaptoru henuz yok (Online Odeme v2 · P3); PAYMENTS_PROVIDERS icinden cikarin');
  },
};

export function loadPaymentsConfig(env: NodeJS.ProcessEnv = process.env): PaymentsRuntimeConfig {
  const ttl = Number(env.PAYMENTS_INTENT_TTL_MINUTES ?? 30);
  if (!Number.isInteger(ttl) || ttl < 5 || ttl > 120) throw new Error('PAYMENTS_INTENT_TTL_MINUTES 5-120 olmali');

  const names = enabledProviderNames(env);
  const defaultRaw = env.DEFAULT_PAYMENT_PROVIDER?.trim() || undefined;
  if (names.length === 0) {
    if (defaultRaw) throw new Error('DEFAULT_PAYMENT_PROVIDER verilmis ama acik saglayici yok (PAYMENTS_PROVIDERS)');
    return { providers: EMPTY_REGISTRY, apiBaseUrl: 'http://localhost:3000', webAppUrl: 'http://localhost:5173', intentTtlMinutes: ttl };
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
    apiBaseUrl,
    webAppUrl,
    intentTtlMinutes: ttl,
  };
}
