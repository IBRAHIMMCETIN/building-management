/**
 * Tasinmada kapi kayitlarinin pasife alinmasi.
 *
 * Kapi kararlari okuma aninda uyelikten verilir (gecisi olusturan / aracin sahibi bolumde hala
 * oturuyor mu; bkz. service.ts `residency`). Bu okuma guvenlik agi olarak kalir; ayrica uyelik
 * bitince (tasinma / cari kapama, uyelik iptali, oturan malikin kiraya vermesi, mulk devri) o
 * kullanicinin o bolumdeki:
 *   - aktif ve suresi dolmamis misafir gecisleri `revoked` olur (`revokeReason: 'taşınma'`),
 *   - sahibi oldugu aktif araclar `inactive` olur (`inactiveReason: 'taşınma'`); plaka dizini o araca
 *     bagliysa o da pasife alinir (plaka yeni sakine gecebilir).
 *
 * Neden zamanlanmis tarama (outbox olayi degil): oturma uyeligin BITIS GUNUNUN SONUNDA biter (okuma
 * kurali `endDate >= bugun`); tasinma cogu zaman bugun veya ileri tarihli kaydedilir. Yazim anindaki
 * bir olay bu durumda yapacak is bulamaz; ayrica uyelik dort farkli yazim yolundan biter. Bu yuzden
 * gunluk `maintenance_tasks` isi (04:10, Istanbul) son `LOOKBACK_DAYS` gunde biten / degisen
 * uyelikleri tarar ve her aday icin bu adimi calistirir.
 *
 * Idempotent: yalnizca hala aktif kayitlara surum kosuluyla yazar; ikinci calisma hicbir sey bulmaz
 * ve yazmaz. Es zamanli degisiklikte (sakin ayni anda iptal etti) yeniden okuyup dener. Her yazim
 * (en fazla `CHUNK` kayit) `gate.departure_release` denetim kaydiyla ayni atomik islemdedir.
 * Kiraci izolasyonu: tum okuma / yazimlar verilen apartmanin bolumunde (`APT#<id>`).
 *
 * Cari kapamayla biten (`endedByClosureId`) veya oturan malikin kapamasiyla oturmasi biten
 * (`residencyEndedByClosureId`) uyelik, kapama geri alinabildigi icin bitis gunu (veya
 * kaydin degistigi gun, hangisi sonraysa) + `CLOSURE_GRACE_DAYS` gun gecene kadar aday degildir; bu
 * surede okuma anindaki kontrol gecisleri zaten reddeder. Tarama SONRASINDA geri alinan kapamada
 * iptal edilen gecisler ve pasife alinan araclar geri gelmez: sakin gecisi yeniden olusturur, arac
 * yonetimce yeniden etkinlestirilir (denetim kaydinda listelidir).
 *
 * Bir adayin hatasi digerlerini durdurmaz: `gate_departure_failed` logu (yalnizca apartman / bolum
 * kimligi, kisi verisi yok) + `GateDepartureFailed` EMF metrigi (operations.tf alarmi); sonraki gun
 * aday hala geriye bakis penceresindeyse yeniden denenir.
 *
 * Aninda adim (`releaseNow`): uyeligi bugun itibariyla oturmayacak sekilde degistiren uyelik
 * yazimlari (PATCH / iptal) ayni atomik islemde `MEMBERSHIP_ENDED` outbox olayi yazar (cari kapama
 * yazmaz: geri alma payi yuzunden karar her zaman gece taramasinindir);
 * olay SNS -> `scheduled-jobs` kuyrugu ile zamanlanmis gorev worker'ina gelir ve yalnizca o
 * kullanici + bolum icin GECE TARAMASININ KURALIYLA (`departureCandidates`, ayni gun ve geriye
 * bakis) `release` calisir. Sonuc taramanin yapacagiyla birebir aynidir, yalnizca erken: bitis
 * bugun ise (bitis gunu boyunca oturur) veya cari kapama geri alma payi dolmadiysa adim hicbir sey
 * yazmaz ve gece taramasi isi zamaninda yapar. Tekrar teslim zararsizdir (idempotent `release`).
 */
import type { MetricsEmitter } from '../../observability/metrics.js';
import type { IsoDate } from '../core/types.js';
import type { MembershipRepository } from '../memberships/repository.js';
import type { UnitMembership } from '../portal/types.js';
import { addDays, istanbulDay, istanbulDayStart, reversePlate } from './model.js';
import { GateConflictError, type GatePut, type GateRepository } from './repository.js';
import { type GuestPass, MAX_PASS_DAYS, MAX_PASS_LEAD_DAYS, type PlateIndex, type UnitPointer, type Vehicle, gateKeys } from './types.js';

export const DEPARTURE_REASON = 'taşınma';
/** Tarama: bitis tarihi veya son degisikligi bu kadar gun icindeki uyelikler (kacan calismalar dahil). */
export const LOOKBACK_DAYS = 7;
/** Cari kapamayla biten uyelikte geri alma payi (gun): bu sure gecmeden pasife alma yapilmaz. */
export const CLOSURE_GRACE_DAYS = 3;
/** Tek atomik yazimdaki en fazla kayit (denetim kaydi + plaka dizinleri dahil 100 sinirinin altinda). */
const CHUNK = 40;
const RETRIES = 3;

export type DepartureCandidate = { userId: string; unitId: string };
export type DepartureResult = { passIds: string[]; vehicleIds: string[] };
/** Aninda adimin sonucu: neden yazilmadigi (`resides`: hala oturuyor, `closure_grace`: kapama payi). */
export type ImmediateDeparture =
  | ({ status: 'released' } & DepartureResult)
  | { status: 'skipped'; reason: 'resides' | 'closure_grace' | 'not_departed' };
/** Denetim kaydina eklenen tetikleyici (gece taramasinda yok). */
export type DepartureTrigger = { trigger: 'membership_ended'; eventId: string };

/** Uye bu gun bolumde oturuyor mu (service.ts `residingUnits` ile ayni kural). */
export function residesOn(m: UnitMembership, day: IsoDate): boolean {
  if (m.status !== 'active' || m.startDate > day || (m.endDate && m.endDate < day)) return false;
  return m.relation === 'tenant' || m.residesInUnit;
}

/**
 * Bugun bolumde oturmayan ve son `lookbackDays` gunde biten / degisen uyelikler (kullanici + bolum).
 * Henuz baslamamis uyelik aday degildir (o bolumde hic oturmadi). Ayni kullanici-bolumde oturan
 * baska bir kayit varsa aday degildir.
 */
export function departureCandidates(memberships: readonly UnitMembership[], apartmentId: string, day: IsoDate, lookbackDays = LOOKBACK_DAYS): DepartureCandidate[] {
  const since = addDays(day, -lookbackDays);
  const sinceTs = istanbulDayStart(since);
  const mine = memberships.filter((m) => m.apartmentId === apartmentId);
  const residing = new Set(mine.filter((m) => residesOn(m, day)).map((m) => `${m.userId}|${m.unitId}`));
  const out = new Map<string, DepartureCandidate>();
  for (const m of mine) {
    const key = `${m.userId}|${m.unitId}`;
    if (residing.has(key) || m.startDate > day || out.has(key)) continue;
    const recent = (m.endDate !== undefined && m.endDate >= since) || (typeof m.updatedAt === 'string' && m.updatedAt >= sinceTs);
    if (!recent) continue;
    // Cari kapama geri alinabilir: bitis (veya kaydin degistigi gun) + pay gecmeden dokunulmaz.
    // Oturan malikin kapamasi (`residencyEndedByClosureId`: uyelik surer, artik oturmuyor) da ayni.
    if (m.endedByClosureId || m.residencyEndedByClosureId) {
      const changed = typeof m.updatedAt === 'string' ? istanbulDay(new Date(m.updatedAt)) : '';
      const base = [m.endDate ?? '', changed].sort().at(-1) ?? '';
      if (!base || day <= addDays(base, CLOSURE_GRACE_DAYS)) continue;
    }
    out.set(key, { userId: m.userId, unitId: m.unitId });
  }
  return [...out.values()];
}

export type GateDeparturesDeps = {
  repo: GateRepository;
  /** `get`: aninda adim yalnizca o uyelik kaydini okur (yoksa bolumun uyelikleri listelenir). */
  memberships: Pick<MembershipRepository, 'list'> & Partial<Pick<MembershipRepository, 'get'>>;
  now: () => Date;
  /** EMF: GateDepartureFailed (operations.tf alarmi). */
  metrics?: MetricsEmitter;
  log?: Pick<Console, 'error'>;
};

export function createGateDepartures(deps: GateDeparturesDeps) {
  const { repo } = deps;

  /** Aktif ve hala kullanilabilir gecisler: en eski aktif gecis en fazla ~121 gun once olusturulmus olabilir. */
  async function activePasses(apartmentId: string, c: DepartureCandidate, day: IsoDate): Promise<GuestPass[]> {
    const oldest = addDays(day, -(MAX_PASS_LEAD_DAYS + MAX_PASS_DAYS + 1)).replace(/-/g, '');
    const prefix = gateKeys.passUnitPrefix(c.unitId);
    const refs: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await repo.query<UnitPointer>(apartmentId, { from: `${prefix}${oldest}`, to: `${prefix}~`, ...(cursor ? { cursor } : {}) });
      refs.push(...page.items.map((p) => p.refId));
      cursor = page.cursor;
    } while (cursor);
    const passes = await repo.getMany<GuestPass>(apartmentId, refs.map((id) => gateKeys.pass(apartmentId, id).SK));
    return passes.filter((p) => p.entityType === 'GATE_PASS' && p.apartmentId === apartmentId && p.unitId === c.unitId && p.createdBy === c.userId && p.status === 'active' && p.validUntil >= day);
  }

  async function activeVehicles(apartmentId: string, c: DepartureCandidate): Promise<Vehicle[]> {
    const refs: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await repo.query<UnitPointer>(apartmentId, { prefix: gateKeys.vehicleUnitPrefix(c.unitId), ...(cursor ? { cursor } : {}) });
      refs.push(...page.items.map((p) => p.refId));
      cursor = page.cursor;
    } while (cursor);
    const vehicles = await repo.getMany<Vehicle>(apartmentId, refs.map((id) => gateKeys.vehicle(apartmentId, id).SK));
    return vehicles.filter((v) => v.entityType === 'GATE_VEHICLE' && v.apartmentId === apartmentId && v.unitId === c.unitId && v.ownerUserId === c.userId && v.status === 'active');
  }

  /** Bir kullanicinin bir bolumdeki aktif gecis ve araclarini pasife alir (idempotent, denetimli). */
  async function release(apartmentId: string, c: DepartureCandidate, day: IsoDate, actorId: string, trigger?: DepartureTrigger): Promise<DepartureResult> {
    const done: DepartureResult = { passIds: [], vehicleIds: [] };
    for (let attempt = 1; ; attempt++) {
      const [passes, vehicles] = await Promise.all([activePasses(apartmentId, c, day), activeVehicles(apartmentId, c)]);
      if (!passes.length && !vehicles.length) return done;
      const plates = new Map(
        (await repo.getMany<PlateIndex>(apartmentId, vehicles.map((v) => gateKeys.plate(apartmentId, reversePlate(v.plate)).SK))).map((p) => [p.vehicleId, p]),
      );
      const ts = deps.now().toISOString();
      type Unit = { kind: 'pass' | 'vehicle'; id: string; puts: GatePut[] };
      const units: Unit[] = [
        ...passes.map((p) => ({
          kind: 'pass' as const,
          id: p.passId,
          puts: [
            {
              item: { ...p, status: 'revoked' as const, revokedAt: ts, revokedBy: actorId, revokeReason: DEPARTURE_REASON, updatedAt: ts, updatedBy: actorId, version: p.version + 1 },
              condition: { kind: 'match' as const, fields: { version: p.version, status: 'active' } },
              reason: 'version' as const,
            },
          ],
        })),
        ...vehicles.map((v) => {
          const index = plates.get(v.vehicleId);
          const puts: GatePut[] = [
            {
              item: { ...v, status: 'inactive', inactiveReason: DEPARTURE_REASON, updatedAt: ts, updatedBy: actorId, version: v.version + 1 },
              condition: { kind: 'match', fields: { version: v.version, status: 'active' } },
              reason: 'version',
            },
          ];
          // Plaka dizini hala bu araca bagli ve aktifse pasife alinir (plaka yeni sakine gecebilir).
          if (index && index.apartmentId === apartmentId && index.status === 'active') {
            puts.push({ item: { ...index, status: 'inactive', updatedAt: ts }, condition: { kind: 'match', fields: { vehicleId: v.vehicleId, status: 'active' } }, reason: 'plate' });
          }
          return { kind: 'vehicle' as const, id: v.vehicleId, puts };
        }),
      ];
      try {
        for (let i = 0; i < units.length; ) {
          const chunk: Unit[] = [];
          let size = 0;
          while (i < units.length && size + (units[i]?.puts.length ?? 0) <= CHUNK) {
            const u = units[i++] as Unit;
            chunk.push(u);
            size += u.puts.length;
          }
          const passIds = chunk.filter((u) => u.kind === 'pass').map((u) => u.id);
          const vehicleIds = chunk.filter((u) => u.kind === 'vehicle').map((u) => u.id);
          await repo.write(apartmentId, {
            puts: chunk.flatMap((u) => u.puts),
            audit: {
              apartmentId,
              action: 'gate.departure_release',
              target: { type: 'membership', id: `${c.userId}:${c.unitId}` },
              actorId,
              reason: DEPARTURE_REASON,
              details: { userId: c.userId, unitId: c.unitId, passIds, vehicleIds, ...(trigger ?? {}) },
            },
          });
          done.passIds.push(...passIds);
          done.vehicleIds.push(...vehicleIds);
        }
        return done;
      } catch (err) {
        // Es zamanli degisiklik (sakin iptal etti, yonetici pasife aldi): guncel kayitlarla tekrar.
        if (err instanceof GateConflictError && attempt < RETRIES) continue;
        throw err;
      }
    }
  }

  /** Apartmandaki son tasinmalar: her aday icin `release`. Bir aday hata verirse digerleri devam eder. */
  async function sweep(apartmentId: string, day: IsoDate, actorId: string) {
    const candidates = departureCandidates(await deps.memberships.list(apartmentId), apartmentId, day);
    let passesRevoked = 0;
    let vehiclesDeactivated = 0;
    let failed = 0;
    for (const c of candidates) {
      try {
        const r = await release(apartmentId, c, day, actorId);
        passesRevoked += r.passIds.length;
        vehiclesDeactivated += r.vehicleIds.length;
      } catch (err) {
        failed++;
        // Kisi verisi yok: yalnizca apartman / bolum ve hata turu.
        (deps.log ?? console).error(JSON.stringify({ msg: 'gate_departure_failed', apartmentId, unitId: c.unitId, error: err instanceof Error ? err.name : 'unknown' }));
        deps.metrics?.emit({ GateDepartureFailed: 1 }, { msg: 'gate_departure_failed', apartmentId, unitId: c.unitId });
      }
    }
    return { candidates: candidates.length, passesRevoked, vehiclesDeactivated, failed };
  }

  /**
   * Aninda adim (`MEMBERSHIP_ENDED`): yalnizca bu kullanici + bolum, gece taramasiyla ayni kural ve
   * gun. Hata firlatir (olay SQS'te yeniden denenir; gece taramasi da guvenlik agidir).
   */
  async function releaseNow(apartmentId: string, target: DepartureCandidate, day: IsoDate, actorId: string, trigger?: DepartureTrigger): Promise<ImmediateDeparture> {
    // Uyelik kullanici + bolum basina tek kayittir (`MEMBER#<user>#<unit>`): yalnizca o okunur.
    const members = (
      deps.memberships.get
        ? [await deps.memberships.get(apartmentId, target.userId, target.unitId)].filter((m): m is UnitMembership => !!m)
        : await deps.memberships.list(apartmentId, { unitId: target.unitId })
    ).filter((m) => m.apartmentId === apartmentId && m.unitId === target.unitId && m.userId === target.userId);
    const candidate = departureCandidates(members, apartmentId, day).find((c) => c.userId === target.userId && c.unitId === target.unitId);
    if (!candidate) {
      if (members.some((m) => residesOn(m, day))) return { status: 'skipped', reason: 'resides' };
      if (members.some((m) => m.endedByClosureId || m.residencyEndedByClosureId)) return { status: 'skipped', reason: 'closure_grace' };
      return { status: 'skipped', reason: 'not_departed' };
    }
    return { status: 'released', ...(await release(apartmentId, candidate, day, actorId, trigger)) };
  }

  return { release, sweep, releaseNow };
}

/**
 * Yazim yolunun karari: bu degisiklikten sonra kullanici bugun bolumde oturmuyor ve degisiklik
 * oturmayi etkiledi mi? (Olay yazilir; asil karar worker'da gece taramasinin kuraliyla verilir.)
 */
export function endsResidency(before: UnitMembership | undefined, after: UnitMembership, day: IsoDate): boolean {
  if (after.startDate > day || residesOn(after, day)) return false;
  if (!before) return false;
  return residesOn(before, day) || before.status !== after.status || before.endDate !== after.endDate || before.residesInUnit !== after.residesInUnit;
}

export type GateDepartures = ReturnType<typeof createGateDepartures>;
