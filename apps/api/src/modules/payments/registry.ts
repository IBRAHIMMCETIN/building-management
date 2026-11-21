/**
 * Online Odeme v2 · P2: saglayici kaydi (registry) ve cozumleyici.
 *
 *  - Kayit: ortamda ACIK saglayicilar (`PAYMENTS_PROVIDERS`) ve varsayilan
 *    (`DEFAULT_PAYMENT_PROVIDER`). Saglayici adiyla bulunur.
 *  - Cozumleme (yeni niyet, alt uye isyeri, yonetici ozeti): apartmanin tercihi
 *    (`PaymentSettings.paymentProvider`) varsa o, yoksa ortam varsayilani. Tercih edilen saglayici
 *    bu ortamda acik degilse online odeme o apartman icin KAPALI sayilir (baska saglayiciya
 *    sessizce dusulmez: alt uye isyeri ve komisyon sozlesmesi saglayiciya ozgudur).
 *  - Mevcut niyet: tum adimlar (sorgu, onay/transfer, iade, webhook) niyete yazilan saglayiciyla
 *    yurur (`get(intent.provider)`); tercih degisse de yarim kalan odeme kendi saglayicisinda biter.
 */
import type { PaymentProvider } from './provider.js';
import { PAYMENT_PROVIDERS, type PaymentProviderName } from './types.js';

export type ProviderRegistry = {
  /** Ortam varsayilani; kayit bossa yok. */
  readonly defaultName?: PaymentProviderName;
  get(name: string | undefined): PaymentProvider | undefined;
  /** Acik saglayicilar (kayit sirasiyla; varsayilan ilk). */
  list(): PaymentProvider[];
  has(name: string | undefined): name is PaymentProviderName;
};

export type ProviderResolution = {
  /** Cozumlenen ad (acik olmasa da): ekranda "tercih edilen saglayici kapali" gosterilebilir. */
  name?: PaymentProviderName;
  /** Bu ortamda acik ise saglayici. */
  provider?: PaymentProvider;
  source: 'apartment' | 'default' | 'none';
};

export const isProviderName = (v: unknown): v is PaymentProviderName =>
  typeof v === 'string' && (PAYMENT_PROVIDERS as readonly string[]).includes(v);

/**
 * Kayit olusturur. Ayni ad iki kez verilemez; varsayilan verilmezse ve tek saglayici varsa o
 * varsayilandir, birden fazlaysa varsayilan zorunludur.
 */
export function createProviderRegistry(providers: PaymentProvider[], defaultName?: PaymentProviderName): ProviderRegistry {
  const byName = new Map<PaymentProviderName, PaymentProvider>();
  for (const p of providers) {
    if (byName.has(p.name)) throw new Error(`Saglayici iki kez kaydedildi: ${p.name}`);
    byName.set(p.name, p);
  }
  let def = defaultName;
  if (def === undefined && byName.size === 1) def = [...byName.keys()][0];
  if (def === undefined && byName.size > 1) throw new Error('Birden fazla saglayici acikken varsayilan saglayici zorunludur');
  if (def !== undefined && !byName.has(def)) throw new Error(`Varsayilan saglayici acik degil: ${def}`);
  const ordered = def ? [byName.get(def) as PaymentProvider, ...[...byName.values()].filter((p) => p.name !== def)] : [];
  return {
    defaultName: def,
    get: (name) => (isProviderName(name) ? byName.get(name) : undefined),
    list: () => ordered,
    has: (name): name is PaymentProviderName => isProviderName(name) && byName.has(name),
  };
}

export const EMPTY_REGISTRY: ProviderRegistry = createProviderRegistry([]);

/** Apartman tercihi + ortam varsayilani -> saglayici. */
export function resolveProvider(registry: ProviderRegistry, preference: PaymentProviderName | undefined): ProviderResolution {
  if (preference) return { name: preference, provider: registry.get(preference), source: 'apartment' };
  if (registry.defaultName) return { name: registry.defaultName, provider: registry.get(registry.defaultName), source: 'default' };
  return { source: 'none' };
}
