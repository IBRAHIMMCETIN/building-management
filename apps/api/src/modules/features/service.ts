import { CoreError } from '../core/service.js';
import type { Site } from '../core/types.js';
import { ValidationError, asObject, assertId, optString, reqInt, reqString } from '../core/validation.js';
import {
  FEATURE_CATALOG,
  FEATURE_PROFILES,
  type FeatureDefinition,
  type FeatureKey,
  type FeatureOverrides,
  type FeatureProfile,
  type ResolvedFeatures,
  type SiteFeatureSettings,
  catalogList,
  diffFeatures,
  isFeatureKey,
  normalizeFeatureSettings,
  resolveFeatures,
} from './catalog.js';
import type { SiteFeatureReader } from './guard.js';
import { type FeatureRepository, type FeatureRequest, FEATURE_REQUEST_INDEX_PK, featureRepository, featureRequestKeys } from './repository.js';

export type SiteFeatureView = {
  apartmentId: string;
  /** Site kaydinin surumu (platform guncellemesinde `version` olarak geri gonderilir). */
  version: number;
  profile: FeatureProfile;
  /** true: kayit yok, Adim 1 oncesi varsayilanlar (legacy) uygulaniyor. */
  inherited: boolean;
  overrides: FeatureOverrides;
  features: ResolvedFeatures;
};

export type FeatureRequestView = Omit<FeatureRequest, 'PK' | 'SK' | 'GSI1PK' | 'GSI1SK'> & { siteName?: string };

export type FeatureServiceDeps = {
  repository: FeatureRepository;
  /** Guncellemeden sonra ayni konteynerdeki guard onbellegi temizlenir. */
  reader?: Pick<SiteFeatureReader, 'invalidate'>;
  now: () => Date;
};

const REASON_MIN = 5;
const REASON_MAX = 500;
const NOTE_MAX = 500;

function requestView(r: FeatureRequest, siteName?: string): FeatureRequestView {
  const { PK: _pk, SK: _sk, GSI1PK: _gp, GSI1SK: _gs, ...rest } = r;
  return siteName ? { ...rest, siteName } : rest;
}

/**
 * Adim 1 - site ozellik anahtarlari servisi.
 *  - `view`: aktif apartmanin etkin ozellikleri (tum apartman rolleri; web menu/kart filtreleri)
 *  - `update`: yalnizca platform; gerekce zorunlu, surum kosullu, denetim kaydi ayni atomik yazimda
 *    (fail closed: denetim yazilamazsa degisiklik de yazilmaz)
 *  - `requestEnable`: yonetici "acilmasini istiyorum" talebi (denetimli, ozellik basina tek acik talep)
 */
export function createFeatureService(overrides: Partial<FeatureServiceDeps> = {}) {
  const deps: FeatureServiceDeps = { repository: featureRepository, now: () => new Date(), ...overrides };
  const repo = deps.repository;
  const stamp = () => deps.now().toISOString();

  async function requireSite(apartmentId: string): Promise<Site> {
    assertId(apartmentId, 'siteId');
    const site = await repo.getSite(apartmentId);
    if (!site) throw new CoreError('not_found', 'Site bulunamadi');
    return site;
  }

  function toView(site: Site): SiteFeatureView {
    const stored = site.settings.features;
    const state = normalizeFeatureSettings(stored);
    return {
      apartmentId: site.siteId,
      version: site.version,
      profile: state.profile,
      inherited: !stored,
      overrides: state.overrides,
      features: resolveFeatures(state),
    };
  }

  async function view(apartmentId: string): Promise<SiteFeatureView> {
    return toView(await requireSite(apartmentId));
  }

  /**
   * Govde: { version, reason, profile?, features?: { '<anahtar>': true | false | null } }
   * `null` override'i kaldirir (profil varsayilanina doner). Degisiklik yoksa yazim yapilmaz.
   */
  async function update(actor: string, apartmentId: string, input: unknown): Promise<SiteFeatureView> {
    const o = asObject(input);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const reason = reqString(o, 'reason', REASON_MAX, REASON_MIN);

    let profile: FeatureProfile | undefined;
    if (o.profile !== undefined) {
      if (typeof o.profile !== 'string' || !(FEATURE_PROFILES as readonly string[]).includes(o.profile)) {
        throw new ValidationError(`profile su degerlerden biri olmali: ${FEATURE_PROFILES.join(', ')}`, 'profile');
      }
      profile = o.profile as FeatureProfile;
    }
    const patch: Partial<Record<FeatureKey, boolean | null>> = {};
    if (o.features !== undefined) {
      const f = asObject(o.features, 'features');
      for (const [k, v] of Object.entries(f)) {
        if (!isFeatureKey(k)) throw new ValidationError(`Bilinmeyen ozellik: ${k}`, 'features');
        if (v !== null && typeof v !== 'boolean') throw new ValidationError(`${k} icin true, false veya null gerekli`, 'features');
        patch[k] = v as boolean | null;
      }
    }
    if (profile === undefined && Object.keys(patch).length === 0) {
      throw new ValidationError('Degistirilecek ozellik veya profil belirtilmedi', 'features');
    }

    const site = await requireSite(apartmentId);
    if (site.version !== version) throw new CoreError('conflict', 'Kayit baska biri tarafindan guncellendi (surum uyusmazligi)');

    const before = normalizeFeatureSettings(site.settings.features);
    const nextOverrides: FeatureOverrides = { ...before.overrides };
    for (const [k, v] of Object.entries(patch) as [FeatureKey, boolean | null][]) {
      if (v === null) delete nextOverrides[k];
      else nextOverrides[k] = v;
    }
    const next: SiteFeatureSettings = { profile: profile ?? before.profile, overrides: nextOverrides };
    const beforeResolved = resolveFeatures(before);
    const afterResolved = resolveFeatures(next);
    const changed = diffFeatures(beforeResolved, afterResolved);
    const stateChanged = !site.settings.features || JSON.stringify(before) !== JSON.stringify(next);
    if (!stateChanged) return toView(site);

    const updated: Site = {
      ...site,
      settings: { ...site.settings, features: next },
      updatedAt: stamp(),
      updatedBy: actor,
      version: site.version + 1,
    };
    await repo.saveSiteFeatures(updated, version, {
      apartmentId,
      action: 'site.features.update',
      target: { type: 'site', id: apartmentId },
      actorId: actor,
      reason,
      details: { profileFrom: before.profile, profileTo: next.profile, changed, overrides: next.overrides, version: updated.version },
    });
    deps.reader?.invalidate(apartmentId);

    // Acilan ozelliklerin bekleyen talepleri "acildi" olarak kapanir (en iyi caba; hata degisikligi geri almaz).
    for (const c of changed.filter((x) => x.to)) {
      try {
        await closeRequestInternal(actor, apartmentId, c.key, 'enabled', reason);
      } catch (err) {
        console.warn(JSON.stringify({ level: 'warn', msg: 'feature_request_close_failed', apartmentId, feature: c.key, error: String(err) }));
      }
    }
    return toView(updated);
  }

  /** Govde: { feature, note? } - aktif apartmanin yoneticisi. */
  async function requestEnable(actor: string, apartmentId: string, input: unknown): Promise<{ created: boolean; request: FeatureRequestView }> {
    const o = asObject(input);
    const feature = o.feature;
    if (!isFeatureKey(feature)) throw new ValidationError('Gecersiz ozellik anahtari', 'feature');
    const note = optString(o, 'note', NOTE_MAX)?.trim() || undefined;

    const site = await requireSite(apartmentId);
    if (resolveFeatures(site.settings.features)[feature]) {
      throw new CoreError('conflict', 'Bu ozellik siteniz icin zaten acik');
    }
    const existing = await repo.getRequest(apartmentId, feature);
    if (existing?.status === 'pending') return { created: false, request: requestView(existing) };

    const ts = stamp();
    const request: FeatureRequest = {
      ...featureRequestKeys(apartmentId, feature),
      entityType: 'FEATURE_REQUEST',
      apartmentId,
      feature,
      status: 'pending',
      ...(note ? { note } : {}),
      requestedBy: actor,
      requestedAt: ts,
      count: (existing?.count ?? 0) + 1,
      createdAt: existing?.createdAt ?? ts,
      createdBy: existing?.createdBy ?? actor,
      updatedAt: ts,
      updatedBy: actor,
      version: (existing?.version ?? 0) + 1,
      GSI1PK: FEATURE_REQUEST_INDEX_PK,
      GSI1SK: `${ts}#${apartmentId}`,
    };
    await repo.putRequest(request, {
      apartmentId,
      action: 'site.features.enable_request',
      target: { type: 'site_feature', id: feature },
      actorId: actor,
      ...(note ? { reason: note } : {}),
      details: { feature, label: FEATURE_CATALOG[feature].label, count: request.count },
    });
    return { created: true, request: requestView(request) };
  }

  async function closeRequestInternal(actor: string, apartmentId: string, feature: FeatureKey, status: 'enabled' | 'dismissed', reason: string): Promise<FeatureRequestView | undefined> {
    const existing = await repo.getRequest(apartmentId, feature);
    if (!existing || existing.status !== 'pending') return undefined;
    const ts = stamp();
    const { GSI1PK: _gp, GSI1SK: _gs, ...rest } = existing;
    const closed: FeatureRequest = { ...rest, status, closedAt: ts, closedBy: actor, closeReason: reason, updatedAt: ts, updatedBy: actor, version: existing.version + 1 };
    await repo.closeRequest(closed, existing.version, {
      apartmentId,
      action: 'site.features.request_close',
      target: { type: 'site_feature', id: feature },
      actorId: actor,
      reason,
      details: { feature, status },
    });
    return requestView(closed);
  }

  /** Platform: talebi acmadan kapatir. Govde: { reason } */
  async function dismissRequest(actor: string, apartmentId: string, feature: string, input: unknown): Promise<FeatureRequestView> {
    if (!isFeatureKey(feature)) throw new ValidationError('Gecersiz ozellik anahtari', 'feature');
    assertId(apartmentId, 'siteId');
    const reason = reqString(asObject(input), 'reason', REASON_MAX, REASON_MIN);
    const closed = await closeRequestInternal(actor, apartmentId, feature, 'dismissed', reason);
    if (!closed) throw new CoreError('not_found', 'Bekleyen talep bulunamadi');
    return closed;
  }

  /** Platform: bekleyen talepler (en yeni once), site adiyla. */
  async function listPendingRequests(): Promise<FeatureRequestView[]> {
    const items = await repo.listPendingRequests();
    const names = new Map<string, string | undefined>();
    for (const id of new Set(items.map((i) => i.apartmentId))) names.set(id, (await repo.getSite(id))?.name);
    return items.map((i) => requestView(i, names.get(i.apartmentId)));
  }

  /** Aktif apartman: kendi talepleri (yalnizca bekleyenler; kapanan talepler denetim gunlugundedir). */
  async function siteRequests(apartmentId: string): Promise<FeatureRequestView[]> {
    assertId(apartmentId, 'siteId');
    return (await repo.listSiteRequests(apartmentId)).filter((r) => r.status === 'pending').map((r) => requestView(r));
  }

  function catalog(): FeatureDefinition[] {
    return catalogList();
  }

  return { view, update, requestEnable, dismissRequest, listPendingRequests, siteRequests, catalog };
}

export type FeatureService = ReturnType<typeof createFeatureService>;
