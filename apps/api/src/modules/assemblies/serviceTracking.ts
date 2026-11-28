/**
 * Genel kurul sonrasi - yasal cagrinin (KMK m.29) malik basina teslim takibi.
 *
 *  - Malik listesi toplanti gunu oy listesinden (dondurulmussa ondan, degilse canli): oy listesindeki
 *    her kat maliki kisi (hisseli bolumde her paydas ayri satir; apartman kullanicisi olmayan malik de).
 *  - Deneme: yontem (imza karsiligi elden / taahhutlu mektup / e-posta bilgilendirme), tarih, referans
 *    no, durum (bekliyor / teslim edildi / iade). Denemeler silinmez; hatali giris gerekceyle iptal
 *    edilir (`voidedAt`), durum gecmisi kayitta kalir. Her yazim denetimli (`assembly.service*`), surumlu.
 *  - "Tebligat yapildi": imza karsiligi elden veya taahhutlu mektupla teslim. E-posta bilgilendirmesi
 *    (sistem e-postasi dahil) yasal cagri sayilmaz (README "Hukuki yorum").
 *  - Sure: olaganustu toplantida (m.29/2) cagri toplantidan en az 15 gun once. Zamanlilik TESLIM
 *    (tebellug) tarihiyle olculur: elden teslimde imza tarihi, taahhutlu mektupta teslim tarihi
 *    (`statusOn`). Daha guvenli okuma: tebligat gunu sayilmaz, 15 tam gun -> toplantidan en az 16 gun
 *    once teslim (`deadline`); tebligat gunu sayilirsa 15 gun once (`deadlineLenient`). Zamaninda
 *    postalanip gec teslim edilen mektup ayri durumdur (`late_delivery`). Son gun gecmis veya 3 gun
 *    icindeyse ve tebligat yapilmamis malik varsa uyari. Olagan toplantida yonetim plani notu (m.29/1).
 *  - Erteleme: her deneme kaydedildigi andaki erteleme sirasini (`rescheduleSeq`) ve toplanti zamanini
 *    tasir; son ertelemeden ONCEKI denemeler eskidir (yeni tarih icin cagri yeniden yapilmali), durum
 *    hesabina girmez.
 */
import type { IsoDate } from '../core/types.js';
import { ValidationError, asObject, assertId, isIsoDate, optString, reqEnum, reqInt, reqString } from '../core/validation.js';
import { DataAccessError } from '../../config/dynamodb.js';
import { addDays } from '../ownership/register.js';
import { istanbulDate } from '../polls/results.js';
import type { RollEntry } from '../polls/rollSnapshot.js';
import { AssemblyError, dayDiff } from './errors.js';
import { assemblyKeys } from './repository.js';
import type { AssemblyContext, AssemblyHelpers, AssemblyServiceDeps } from './service.js';
import {
  type Assembly,
  type AssemblyServiceRecord,
  CALL_NOTICE_DAYS,
  LEGAL_SERVICE_METHODS,
  MAX_SERVICE_ATTEMPTS,
  SERVICE_METHODS,
  type ServiceAttempt,
  type ServiceStatus,
} from './types.js';

/** Son gune bu kadar gun kala tebligat yapilmamis malik varsa "riskte" uyarisi. */
export const SERVICE_RISK_DAYS = 3;

export const SERVICE_METHOD_LABELS = { hand_signed: 'İmza karşılığı elden', registered_mail: 'Taahhütlü mektup', email_info: 'E-posta bilgilendirme' } as const;

/** Daha guvenli okuma (tebligat gunu sayilmaz): teslim toplantidan en az bu kadar gun once. */
export const SERVICE_NOTICE_DAYS = CALL_NOTICE_DAYS + 1;

/**
 * `served`: guvenli son gune kadar teslim; `late_delivery`: zamaninda postalandi ama gec teslim;
 * `served_late`: gec postalandi ve teslim edildi; `pending` / `returned` / `none`.
 */
export type ServiceState = 'served' | 'late_delivery' | 'served_late' | 'pending' | 'returned' | 'none';

export type ServiceRow = {
  ownerId: string;
  name?: string;
  units: { unitId: string; blockId: string; number: string }[];
  state: ServiceState;
  servedOn?: IsoDate;
  attempts: Omit<ServiceAttempt, 'history'>[];
  version: number;
};

const MAX_DATE_TEXT = 'YYYY-AA-GG biçiminde bir tarih olmalı';

function reqDate(o: Record<string, unknown>, key: string): IsoDate {
  const v = o[key];
  if (typeof v !== 'string' || !isIsoDate(v)) throw new ValidationError(`${key} ${MAX_DATE_TEXT}`, key);
  return v;
}

/** Deneme son ertelemeden once mi kaydedildi (eski tarih icin)? Eski kayitta sira yok: 0. */
export const isStale = (x: Pick<ServiceAttempt, 'rescheduleSeq'>, reschedules: number) => (x.rescheduleSeq ?? 0) < reschedules;

/**
 * Malikin tebligat durumu: gecerli (iptal edilmemis, son ertelemeden sonra kaydedilmis) yasal yontemli
 * teslimler esas; zamanlilik teslim tarihiyle (`statusOn`; yoksa gonderim tarihi).
 */
export function serviceState(attempts: readonly ServiceAttempt[], deadline: IsoDate, reschedules = 0): { state: ServiceState; servedOn?: IsoDate } {
  const legal = attempts.filter((x) => !x.voidedAt && !isStale(x, reschedules) && LEGAL_SERVICE_METHODS.includes(x.method));
  const deliveredOn = (x: ServiceAttempt) => x.statusOn ?? x.sentOn;
  const delivered = legal.filter((x) => x.status === 'delivered').sort((x, y) => deliveredOn(x).localeCompare(deliveredOn(y)));
  const first = delivered[0];
  if (first) {
    const on = deliveredOn(first);
    if (on <= deadline) return { state: 'served', servedOn: on };
    return { state: delivered.some((x) => x.sentOn <= deadline) ? 'late_delivery' : 'served_late', servedOn: on };
  }
  if (legal.some((x) => x.status === 'pending')) return { state: 'pending' };
  if (legal.some((x) => x.status === 'returned')) return { state: 'returned' };
  return { state: 'none' };
}

/** m.29 uyarilari (engel degil). `today`: Istanbul gunu. */
export function serviceWarnings(
  a: Pick<Assembly, 'kind' | 'secondMeeting' | 'rollDate'>,
  counts: { owners: number; served: number; servedLate: number; lateDelivery?: number; staleAttempts?: number },
  today: IsoDate,
): string[] {
  const deadline = addDays(a.rollDate, -SERVICE_NOTICE_DAYS);
  const lenient = addDays(a.rollDate, -CALL_NOTICE_DAYS);
  const left = dayDiff(today, deadline);
  const late = counts.servedLate + (counts.lateDelivery ?? 0);
  const unserved = counts.owners - counts.served - late;
  const out: string[] = [];
  if (a.secondMeeting) {
    out.push('İkinci toplantının yeri ve zamanı ilk toplantının çağrısında bildirilir (KMK m.29/3); bu liste ilk çağrının tebliğini izlemek için kullanılabilir.');
    return out;
  }
  if (counts.staleAttempts) {
    out.push(`Toplantı ertelendi: önceki tarih için kaydedilen ${counts.staleAttempts} teslim denemesi yeni tarih için geçerli sayılmaz; yeni tarih için çağrıyı yeniden tebliğ edin.`);
  }
  if (a.kind === 'extraordinary') {
    if (unserved > 0 && left < 0) {
      out.push(`KMK m.29/2 süresi geçti: ${unserved} kat malikine toplantıdan en az ${CALL_NOTICE_DAYS} gün önce (tebligat günü sayılmadan en geç ${deadline}) imza karşılığı veya taahhütlü mektupla çağrı tebliğ edildiği kayıtlı değil. Toplantıyı erteleyip çağrıyı yenilemeyi değerlendirin; aksi halde kararlar iptal davası riski taşır.`);
    } else if (unserved > 0 && left <= SERVICE_RISK_DAYS) {
      out.push(`KMK m.29/2 süresi riskte: ${unserved} kat malikine en geç ${deadline} tarihine kadar (${left} gün) imza karşılığı veya taahhütlü mektupla çağrı tebliğ edilmeli (tebligat günü sayılırsa son gün ${lenient}).`);
    }
    if (counts.lateDelivery) out.push(`${counts.lateDelivery} kat malikine çağrı zamanında postalandı ancak ${deadline} tarihinden sonra teslim edildi; teslim tarihi esas alınırsa süre karşılanmamış olabilir (KMK m.29/2).`);
    if (counts.servedLate > 0) out.push(`${counts.servedLate} kat malikine çağrı ${CALL_NOTICE_DAYS} günlük süre geçtikten sonra tebliğ edildi (KMK m.29/2).`);
  } else {
    out.push('Olağan toplantı yönetim planında gösterilen zamanda yapılır (KMK m.29/1); yönetim planınız çağrı usulü ve süresi öngörüyorsa bu listeyle izleyin.');
    if (unserved > 0 && left <= SERVICE_RISK_DAYS) out.push(`${unserved} kat malikine yasal yöntemle çağrı tebliğ edildiği kayıtlı değil (15 günlük süre için son teslim günü ${deadline}).`);
  }
  return out;
}

export function createServiceTracking(deps: AssemblyServiceDeps, h: AssemblyHelpers) {
  const repo = deps.repository;
  const today = () => istanbulDate(h.stamp());

  async function rollEntries(ctx: AssemblyContext, a: Assembly): Promise<RollEntry[]> {
    if (a.roll) return deps.rolls.entries(ctx.apartmentId, 'assembly', a.assemblyId);
    return (await h.snapshot(ctx, 'assembly', a.assemblyId, a.rollDate, h.stamp())).entries;
  }

  /** Oy listesindeki her malik kisi ve bolumleri (hisseli bolumde her paydas). */
  function ownersOf(entries: readonly RollEntry[]) {
    const out = new Map<string, { unitId: string; blockId: string; number: string }[]>();
    for (const e of entries) {
      for (const o of e.owners) out.set(o.userId, [...(out.get(o.userId) ?? []), { unitId: e.unitId, blockId: e.blockId, number: e.number }]);
    }
    return out;
  }

  const attemptView = ({ history: _h, ...rest }: ServiceAttempt, reschedules = 0) => ({ ...rest, ...(isStale(rest, reschedules) ? { stale: true } : {}) });

  /** Tebligat raporu: malik basina durum, ozet ve m.29 uyarilari. `filter=unserved`: tebligat yapilmamislar. */
  async function serviceReport(ctx: AssemblyContext, id: string, q: { filter?: string } = {}) {
    if (q.filter !== undefined && q.filter !== 'unserved') throw new ValidationError('filter yalnızca "unserved" olabilir', 'filter');
    const a = await h.requireAssembly(ctx, id);
    const [entries, records, names] = await Promise.all([rollEntries(ctx, a), repo.listServiceRecords(ctx.apartmentId, a.assemblyId), h.names(ctx)]);
    const deadline = addDays(a.rollDate, -SERVICE_NOTICE_DAYS);
    const reschedules = a.reschedules?.length ?? 0;
    const recOf = new Map(records.filter((r) => r.apartmentId === ctx.apartmentId).map((r) => [r.ownerId, r]));
    let staleAttempts = 0;
    const rows: ServiceRow[] = [...ownersOf(entries)].map(([ownerId, units]) => {
      const rec = recOf.get(ownerId);
      const s = serviceState(rec?.attempts ?? [], deadline, reschedules);
      staleAttempts += (rec?.attempts ?? []).filter((x) => !x.voidedAt && isStale(x, reschedules)).length;
      return {
        ownerId,
        ...(names.get(ownerId) ? { name: names.get(ownerId) } : {}),
        units,
        state: s.state,
        ...(s.servedOn ? { servedOn: s.servedOn } : {}),
        attempts: (rec?.attempts ?? []).map((x) => attemptView(x, reschedules)),
        version: rec?.version ?? 0,
      };
    });
    rows.sort((x, y) => (x.name ?? '~').localeCompare(y.name ?? '~', 'tr') || x.ownerId.localeCompare(y.ownerId));
    const count = (s: ServiceState) => rows.filter((r) => r.state === s).length;
    const summary = {
      owners: rows.length,
      served: count('served'),
      lateDelivery: count('late_delivery'),
      servedLate: count('served_late'),
      pending: count('pending'),
      returned: count('returned'),
      none: count('none'),
      staleAttempts,
    };
    const unserved = rows.filter((r) => r.state !== 'served' && r.state !== 'served_late' && r.state !== 'late_delivery');
    return {
      assemblyId: a.assemblyId,
      kind: a.kind,
      secondMeeting: a.secondMeeting,
      rollFrozen: Boolean(a.roll),
      scheduledAt: a.scheduledAt,
      deadline,
      deadlineLenient: addDays(a.rollDate, -CALL_NOTICE_DAYS),
      daysToDeadline: dayDiff(today(), deadline),
      summary: { ...summary, unserved: unserved.length },
      warnings: a.status === 'cancelled' ? [] : serviceWarnings(a, summary, today()),
      rows: q.filter === 'unserved' ? unserved : rows,
    };
  }

  async function write(ctx: AssemblyContext, next: AssemblyServiceRecord, expected: number, action: string, details: Record<string, unknown>, reason: string | undefined, reschedules: number) {
    try {
      await repo.putServiceRecord(next, expected, {
        apartmentId: ctx.apartmentId,
        action,
        target: { type: 'assembly', id: next.assemblyId },
        actorId: ctx.userId,
        ...(reason ? { reason } : {}),
        // Kisi kimligi (ad degil) ve tarih / yontem; referans no ve not denetime yazilmaz.
        details: { ownerId: next.ownerId, ...details },
      });
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') throw new AssemblyError('conflict', 'Tebligat kaydı bu arada değişti veya toplantı iptal edildi; sayfayı yenileyin');
      throw err;
    }
    const { PK: _pk, SK: _sk, ...rest } = next;
    return { record: { ...rest, attempts: rest.attempts.map((x) => attemptView(x, reschedules)) } };
  }

  async function loadFor(ctx: AssemblyContext, id: string, ownerId: string, version: number) {
    assertId(ownerId, 'ownerId');
    const a = await h.requireAssembly(ctx, id);
    if (a.status === 'cancelled') throw new AssemblyError('conflict', 'İptal edilen toplantıya tebligat kaydı girilmez');
    if (!ownersOf(await rollEntries(ctx, a)).has(ownerId)) throw new AssemblyError('not_found', 'Kişi toplantının oy listesinde kat maliki değil');
    const rec = await repo.getServiceRecord(ctx.apartmentId, a.assemblyId, ownerId);
    if ((rec?.version ?? 0) !== version) throw new AssemblyError('conflict', 'Tebligat kaydı başka bir işlemle değişti (sürüm uyuşmazlığı)');
    return { a, rec };
  }

  /** Yeni teslim denemesi. `version`: malikin kaydinin surumu (ilk kayitta 0). */
  async function addServiceAttempt(ctx: AssemblyContext, id: string, ownerId: string, body: unknown) {
    const o = asObject(body);
    const version = reqInt(o, 'version', 0, Number.MAX_SAFE_INTEGER);
    const method = reqEnum(o, 'method', SERVICE_METHODS);
    const sentOn = reqDate(o, 'sentOn');
    const referenceNo = optString(o, 'referenceNo', 60);
    const note = optString(o, 'note', 300);
    const defaultStatus: ServiceStatus = method === 'registered_mail' ? 'pending' : 'delivered';
    const status = o.status === undefined ? defaultStatus : reqEnum(o, 'status', ['pending', 'delivered', 'returned'] as const);
    if (method === 'registered_mail' && !referenceNo) throw new ValidationError('Taahhütlü mektupta gönderi (barkod) numarası girilmeli', 'referenceNo');
    const statusOn = status === 'pending' ? undefined : o.statusOn === undefined ? sentOn : reqDate(o, 'statusOn');
    if (sentOn > today() || (statusOn && statusOn > today())) throw new ValidationError('Tarih bugünden sonra olamaz', 'sentOn');
    if (statusOn && statusOn < sentOn) throw new ValidationError('Teslim / iade tarihi gönderim tarihinden önce olamaz', 'statusOn');
    const { a, rec } = await loadFor(ctx, id, ownerId, version);
    if (sentOn > a.rollDate) throw new ValidationError('Gönderim tarihi toplantı gününden sonra olamaz', 'sentOn');
    const attempts = rec?.attempts ?? [];
    if (attempts.length >= MAX_SERVICE_ATTEMPTS) throw new AssemblyError('unprocessable', `Bir malik için en fazla ${MAX_SERVICE_ATTEMPTS} teslim denemesi kaydedilir`);
    const now = h.stamp();
    const attempt: ServiceAttempt = {
      seq: attempts.length + 1,
      method,
      sentOn,
      ...(referenceNo ? { referenceNo } : {}),
      status,
      ...(statusOn ? { statusOn } : {}),
      ...(note ? { note } : {}),
      history: [{ status, ...(statusOn ? { statusOn } : {}), at: now, by: ctx.userId }],
      // Hangi toplanti tarihi icin: sonraki ertelemede bu deneme eskir.
      meetingAt: a.scheduledAt,
      rescheduleSeq: a.reschedules?.length ?? 0,
      recordedAt: now,
      recordedBy: ctx.userId,
    };
    const next: AssemblyServiceRecord = {
      ...assemblyKeys.service(ctx.apartmentId, a.assemblyId, ownerId),
      entityType: 'ASSEMBLY_SERVICE',
      apartmentId: ctx.apartmentId,
      assemblyId: a.assemblyId,
      ownerId,
      attempts: [...attempts, attempt],
      updatedAt: now,
      updatedBy: ctx.userId,
      version: version + 1,
    };
    const deadline = addDays(a.rollDate, -SERVICE_NOTICE_DAYS);
    return write(ctx, next, version, 'assembly.service', { seq: attempt.seq, method, sentOn, status, legal: LEGAL_SERVICE_METHODS.includes(method), postedTimely: sentOn <= deadline, rescheduleSeq: attempt.rescheduleSeq }, undefined, a.reschedules?.length ?? 0);
  }

  /**
   * Deneme guncelleme: bekleyen denemenin sonucu (teslim edildi / iade) veya hatali girisin gerekceli
   * iptali (`void: true`). Sonuclanmis deneme degistirilemez; duzeltme iptal + yeni denemeyle.
   */
  async function updateServiceAttempt(ctx: AssemblyContext, id: string, ownerId: string, seqParam: string, body: unknown) {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    if (!/^\d{1,2}$/.test(seqParam)) throw new ValidationError('Geçersiz deneme numarası', 'seq');
    const seq = Number(seqParam);
    const { a, rec } = await loadFor(ctx, id, ownerId, version);
    const cur = rec?.attempts.find((x) => x.seq === seq);
    if (!rec || !cur) throw new AssemblyError('not_found', 'Teslim denemesi bulunamadı');
    if (cur.voidedAt) throw new AssemblyError('conflict', 'İptal edilen deneme değiştirilemez');
    const now = h.stamp();
    let updated: ServiceAttempt;
    let action: string;
    let details: Record<string, unknown>;
    let reason: string | undefined;
    if (o.void === true) {
      reason = reqString(o, 'reason', 300, 3);
      updated = { ...cur, voidedAt: now, voidedBy: ctx.userId, voidReason: reason };
      action = 'assembly.service_void';
      details = { seq };
    } else {
      if (cur.status !== 'pending') throw new AssemblyError('conflict', 'Sonuçlanmış deneme değiştirilemez; hatalıysa iptal edip yeni deneme girin');
      const status = reqEnum(o, 'status', ['delivered', 'returned'] as const);
      const statusOn = reqDate(o, 'statusOn');
      if (statusOn > today()) throw new ValidationError('Tarih bugünden sonra olamaz', 'statusOn');
      if (statusOn < cur.sentOn) throw new ValidationError('Teslim / iade tarihi gönderim tarihinden önce olamaz', 'statusOn');
      const note = optString(o, 'note', 300);
      updated = { ...cur, status, statusOn, ...(note ? { note } : {}), history: [...cur.history, { status, statusOn, at: now, by: ctx.userId, ...(note ? { note } : {}) }] };
      action = 'assembly.service_update';
      details = { seq, status, statusOn };
    }
    const next: AssemblyServiceRecord = { ...rec, attempts: rec.attempts.map((x) => (x.seq === seq ? updated : x)), updatedAt: now, updatedBy: ctx.userId, version: rec.version + 1 };
    return write(ctx, next, version, action, details, reason, a.reschedules?.length ?? 0);
  }

  return { serviceReport, addServiceAttempt, updateServiceAttempt };
}
