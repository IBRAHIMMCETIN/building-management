import { createHash, randomUUID } from 'node:crypto';
import { DataAccessError } from '../../config/dynamodb.js';
import type { AuditDraft } from '../audit/log.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import type { IsoDateTime } from '../core/types.js';
import { type Obj, ValidationError, asObject, assertId, optBool, optString, reqEnum, reqInt, reqString } from '../core/validation.js';
import { DocumentError } from '../documents/errors.js';
import { assemblySheetKey, contentDisposition } from '../documents/keys.js';
import { renderReportPdf } from '../documents/reportPdf.js';
import { type DocumentStore, URL_TTL_SECONDS, createDocumentStoreFromEnv } from '../documents/store.js';
import { type MembershipRepository, membershipRepository } from '../memberships/repository.js';
import { formatDate, formatDateTime } from '../notifications/templates.js';
import { type VotingRollItem, buildVotingRoll } from '../ownership/register.js';
import { type OwnershipRepository, ownershipRepository } from '../ownership/repository.js';
import { PollError } from '../polls/errors.js';
import { istanbulDate } from '../polls/results.js';
import { type PersonRepository, personRepository } from '../residents/repository.js';
import { type Quorum, assemblyQuorum, decide } from './quorum.js';
import { type AssemblyRepository, assemblyKeys, assemblyRepository } from './repository.js';
import { ASSEMBLY_KINDS, ATTENDANCE_MODES, type AgendaItem, type Assembly, type AssemblyAttendance, MAX_AGENDA_ITEMS } from './types.js';

/**
 * Y1-3 - Kat malikleri kurulu (genel kurul) hazirligi: toplanti kaydi (olagan / olaganustu, tarih,
 * yer veya cevrim ici baglanti, gundem), oy listesinden hazirun cetveli (PDF), katilim girisi
 * (asaleten / vekaleten), KMK m.30 yeter sayi kontrolu ve gundem maddesi basina sayim.
 *  - Oy listesi toplanti gunu (Europe/Istanbul) icin mulkiyet modulunden (`buildVotingRoll`).
 *  - Sayim yalnizca toplanti yeter sayisi saglandiysa (ikinci toplantida aranmaz) kaydedilir;
 *    karar katilanlarin sayi cogunluguyla. Sayim ve katilim denetim zincirine yazilir.
 *  - Silme yok: iptal `cancelled`, katilim `absent` ile geri alinir.
 */

/** Hata kodlari anket / oylama ile ortak (Y1). */
export class AssemblyError extends PollError {
  override name = 'AssemblyError';
}

export const KIND_LABELS = { ordinary: 'Olağan', extraordinary: 'Olağanüstü' } as const;

export type AssemblyContext = { apartmentId: string; userId: string };

export type AssemblyServiceDeps = {
  repository: AssemblyRepository;
  core: Pick<CoreRepository, 'listUnits' | 'listBlocks' | 'getSite'>;
  ownership: Pick<OwnershipRepository, 'listHeads' | 'listRecords'>;
  memberships: Pick<MembershipRepository, 'list'>;
  people: Pick<PersonRepository, 'list'>;
  store: DocumentStore | undefined;
  now: () => Date;
  newId: () => string;
};

export type AssemblyView = Omit<Assembly, 'PK' | 'SK'>;

export type AssemblyUnitRow = {
  unitId: string;
  blockId: string;
  number: string;
  landShare?: { numerator: number; denominator: number };
  owners: { userId: string; name?: string; share?: { numerator: number; denominator: number } }[];
  attendance?: Pick<AssemblyAttendance, 'mode' | 'attendeeName' | 'proxyName' | 'recordedAt' | 'version'>;
  warnings: string[];
};

function parseDateTime(o: Obj, key: string): IsoDateTime {
  const v = reqString(o, key, 40);
  const ms = Date.parse(v);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v) || !/(Z|[+-]\d{2}:\d{2})$/.test(v) || Number.isNaN(ms)) {
    throw new ValidationError(`${key} saat dilimli ISO 8601 tarih-saat olmalıdır (örnek 2026-12-15T19:00:00+03:00)`, key);
  }
  return new Date(ms).toISOString();
}

function parseAgenda(value: unknown): AgendaItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_AGENDA_ITEMS) {
    throw new ValidationError(`Gündem 1-${MAX_AGENDA_ITEMS} maddeden oluşmalı`, 'agenda');
  }
  return value.map((raw, i) => {
    const o: Obj = typeof raw === 'string' ? { title: raw } : asObject(raw, `agenda[${i}]`);
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (title.length < 1 || title.length > 300) throw new ValidationError(`${i + 1}. gündem maddesi 1-300 karakter olmalıdır`, 'agenda');
    const description = typeof o.description === 'string' && o.description.trim() ? o.description.trim().slice(0, 2000) : undefined;
    return { itemId: `a${i + 1}`, title, ...(description ? { description } : {}) };
  });
}

function parseUrl(o: Obj): string | undefined {
  const v = optString(o, 'onlineUrl', 500);
  if (v === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new ValidationError('Çevrim içi bağlantı geçerli bir adres olmalıdır', 'onlineUrl');
  }
  if (url.protocol !== 'https:') throw new ValidationError('Çevrim içi bağlantı https:// ile başlamalıdır', 'onlineUrl');
  return url.toString();
}

const shareText = (s: { numerator: number; denominator: number }) => `${s.numerator}/${s.denominator}`;

export function createAssemblyService(overrides: Partial<AssemblyServiceDeps> = {}) {
  const deps: AssemblyServiceDeps = {
    repository: assemblyRepository,
    core: coreRepository,
    ownership: ownershipRepository,
    memberships: membershipRepository,
    people: personRepository,
    store: 'store' in overrides ? overrides.store : createDocumentStoreFromEnv(),
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.repository;
  const stamp = (): IsoDateTime => deps.now().toISOString();
  const view = (a: Assembly): AssemblyView => {
    const { PK: _pk, SK: _sk, ...rest } = a;
    return rest;
  };

  async function requireAssembly(ctx: AssemblyContext, id: string): Promise<Assembly> {
    assertId(id, 'assemblyId');
    const a = await repo.get(ctx.apartmentId, id);
    if (!a || a.apartmentId !== ctx.apartmentId) throw new AssemblyError('not_found', 'Genel kurul kaydı bulunamadı');
    return a;
  }

  const requirePlanned = (a: Assembly) => {
    if (a.status !== 'planned') throw new AssemblyError('conflict', 'İptal edilen toplantı değiştirilemez');
  };

  function assertVersion(a: Assembly, version: number): void {
    if (a.version !== version) throw new AssemblyError('conflict', 'Kayıt başka bir işlemle değiştirildi (sürüm uyuşmazlığı)');
  }

  async function save(next: Assembly, expectedVersion: number, audit?: AuditDraft): Promise<AssemblyView> {
    try {
      await repo.update(next, expectedVersion, audit);
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') throw new AssemblyError('conflict', 'Kayıt başka bir işlemle değiştirildi (sürüm uyuşmazlığı)');
      throw err;
    }
    return view(next);
  }

  const audit = (ctx: AssemblyContext, a: Assembly, action: string, details: Record<string, unknown>, reason?: string): AuditDraft => ({
    apartmentId: ctx.apartmentId,
    action,
    target: { type: 'assembly', id: a.assemblyId },
    actorId: ctx.userId,
    ...(reason ? { reason } : {}),
    details,
  });

  function meetingFields(o: Obj, current?: Assembly) {
    const kind = o.kind === undefined && current ? current.kind : reqEnum(o, 'kind', ASSEMBLY_KINDS);
    const scheduledAt = o.scheduledAt === undefined && current ? current.scheduledAt : parseDateTime(o, 'scheduledAt');
    const location = o.location === undefined ? current?.location : o.location === null ? undefined : optString(o, 'location', 300);
    const onlineUrl = o.onlineUrl === undefined ? current?.onlineUrl : o.onlineUrl === null ? undefined : parseUrl(o);
    if (!location && !onlineUrl) throw new ValidationError('Toplantı yeri veya çevrim içi bağlantı girilmeli', 'location');
    const secondMeeting = optBool(o, 'secondMeeting') ?? current?.secondMeeting ?? false;
    const agenda = o.agenda === undefined && current ? current.agenda : parseAgenda(o.agenda);
    return { kind, scheduledAt, rollDate: istanbulDate(scheduledAt), secondMeeting, agenda, ...(location ? { location } : {}), ...(onlineUrl ? { onlineUrl } : {}) };
  }

  // -------------------------------------------------------------------------
  // Oy listesi ve katilim
  // -------------------------------------------------------------------------

  async function loadRoll(ctx: AssemblyContext, a: Assembly): Promise<VotingRollItem[]> {
    const [units, heads, records, members] = await Promise.all([
      deps.core.listUnits(ctx.apartmentId),
      deps.ownership.listHeads(ctx.apartmentId),
      deps.ownership.listRecords(ctx.apartmentId),
      deps.memberships.list(ctx.apartmentId, {}),
    ]);
    return buildVotingRoll({
      units: units.filter((u) => u.siteId === ctx.apartmentId),
      heads: heads.filter((h) => h.apartmentId === ctx.apartmentId),
      records: records.filter((r) => r.apartmentId === ctx.apartmentId),
      memberships: members.filter((m) => m.apartmentId === ctx.apartmentId),
      day: a.rollDate,
    }).items;
  }

  async function state(ctx: AssemblyContext, a: Assembly) {
    const [roll, attendance] = await Promise.all([loadRoll(ctx, a), repo.listAttendance(ctx.apartmentId, a.assemblyId)]);
    return { roll, attendance, quorum: assemblyQuorum({ roll, attendance, secondMeeting: a.secondMeeting }) };
  }

  async function rows(ctx: AssemblyContext, roll: VotingRollItem[], attendance: AssemblyAttendance[]): Promise<AssemblyUnitRow[]> {
    const people = await deps.people.list(ctx.apartmentId);
    const nameOf = new Map(people.filter((p) => p.apartmentId === ctx.apartmentId).map((p) => [p.userId, p.fullName]));
    const attOf = new Map(attendance.map((x) => [x.unitId, x]));
    return roll.map((r) => {
      const att = attOf.get(r.unitId);
      return {
        unitId: r.unitId,
        blockId: r.blockId,
        number: r.number,
        ...(r.landShare ? { landShare: r.landShare } : {}),
        owners: r.owners.map((o) => ({ userId: o.userId, ...(nameOf.get(o.userId) ? { name: nameOf.get(o.userId) } : {}), ...(o.share && r.owners.length > 1 ? { share: o.share } : {}) })),
        ...(att
          ? { attendance: { mode: att.mode, recordedAt: att.recordedAt, version: att.version, ...(att.attendeeName ? { attendeeName: att.attendeeName } : {}), ...(att.proxyName ? { proxyName: att.proxyName } : {}) } }
          : {}),
        // Kurulda paydaslar temsilci secer (KMK m.31); oy listesinin uyarilari aynen gosterilir.
        warnings: r.warnings,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Toplanti kaydi
  // -------------------------------------------------------------------------

  async function create(ctx: AssemblyContext, body: unknown): Promise<AssemblyView> {
    const o = asObject(body);
    const ts = stamp();
    const assemblyId = deps.newId();
    const a: Assembly = {
      ...assemblyKeys.assembly(ctx.apartmentId, assemblyId),
      entityType: 'ASSEMBLY',
      assemblyId,
      apartmentId: ctx.apartmentId,
      ...meetingFields(o),
      status: 'planned',
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    await repo.create(a);
    return view(a);
  }

  async function list(ctx: AssemblyContext): Promise<AssemblyView[]> {
    return (await repo.list(ctx.apartmentId))
      .filter((a) => a.apartmentId === ctx.apartmentId)
      .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt) || b.assemblyId.localeCompare(a.assemblyId))
      .map(view);
  }

  async function detail(ctx: AssemblyContext, id: string): Promise<{ assembly: AssemblyView; quorum: Quorum; units: AssemblyUnitRow[] }> {
    const a = await requireAssembly(ctx, id);
    const s = await state(ctx, a);
    return { assembly: view(a), quorum: s.quorum, units: await rows(ctx, s.roll, s.attendance) };
  }

  async function update(ctx: AssemblyContext, id: string, body: unknown): Promise<AssemblyView> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await requireAssembly(ctx, id);
    assertVersion(current, version);
    requirePlanned(current);
    if (current.agenda.some((i) => i.tally)) throw new AssemblyError('conflict', 'Sayım kaydedilen toplantının bilgileri ve gündemi değiştirilemez');
    const { location: _l, onlineUrl: _u, ...rest } = current;
    const next: Assembly = { ...rest, ...meetingFields(o, current), updatedAt: stamp(), updatedBy: ctx.userId, version: current.version + 1 };
    return save(next, current.version);
  }

  async function cancel(ctx: AssemblyContext, id: string, body: unknown): Promise<AssemblyView> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const reason = reqString(o, 'reason', 500, 3);
    const current = await requireAssembly(ctx, id);
    assertVersion(current, version);
    requirePlanned(current);
    const now = stamp();
    const next: Assembly = { ...current, status: 'cancelled', cancelledAt: now, cancelReason: reason, updatedAt: now, updatedBy: ctx.userId, version: current.version + 1 };
    return save(next, current.version, audit(ctx, next, 'assembly.cancel', { kind: next.kind, scheduledAt: next.scheduledAt }, reason));
  }

  async function setAttendance(ctx: AssemblyContext, id: string, unitId: string, body: unknown) {
    const o = asObject(body);
    assertId(unitId, 'unitId');
    const mode = reqEnum(o, 'mode', ATTENDANCE_MODES);
    const attendeeName = mode === 'absent' ? undefined : optString(o, 'attendeeName', 150);
    const proxyName = mode === 'proxy' ? reqString(o, 'proxyName', 150) : undefined;
    const a = await requireAssembly(ctx, id);
    requirePlanned(a);
    const roll = await loadRoll(ctx, a);
    if (!roll.some((r) => r.unitId === unitId)) throw new AssemblyError('not_found', 'Bölüm oy listesinde yok');
    const existing = await repo.getAttendance(ctx.apartmentId, a.assemblyId, unitId);
    if (existing && existing.mode === mode && existing.attendeeName === attendeeName && existing.proxyName === proxyName) return { attendance: existing };
    const att: AssemblyAttendance = {
      ...assemblyKeys.attendance(ctx.apartmentId, a.assemblyId, unitId),
      entityType: 'ASSEMBLY_ATTENDANCE',
      apartmentId: ctx.apartmentId,
      assemblyId: a.assemblyId,
      unitId,
      mode,
      ...(attendeeName ? { attendeeName } : {}),
      ...(proxyName ? { proxyName } : {}),
      recordedAt: stamp(),
      recordedBy: ctx.userId,
      version: (existing?.version ?? 0) + 1,
    };
    try {
      // Ad / vekil adi kisisel veri: denetim ayrintisina yazilmaz.
      await repo.putAttendance(att, existing?.version ?? 0, audit(ctx, a, 'assembly.attendance', { unitId, mode }));
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') throw new AssemblyError('conflict', 'Katılım bu arada değişti veya toplantı iptal edildi; sayfayı yenileyin');
      throw err;
    }
    const { PK: _pk, SK: _sk, ...rest } = att;
    return { attendance: rest };
  }

  async function recordTally(ctx: AssemblyContext, id: string, itemId: string, body: unknown): Promise<{ assembly: AssemblyView; quorum: Quorum }> {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const yes = reqInt(o, 'yes', 0, 100_000);
    const no = reqInt(o, 'no', 0, 100_000);
    const abstain = reqInt(o, 'abstain', 0, 100_000);
    const a = await requireAssembly(ctx, id);
    assertVersion(a, version);
    requirePlanned(a);
    const item = a.agenda.find((i) => i.itemId === itemId);
    if (!item) throw new AssemblyError('not_found', 'Gündem maddesi bulunamadı');
    const { quorum } = await state(ctx, a);
    if (!quorum.met) {
      throw new AssemblyError(
        'unprocessable',
        `Toplantı yeter sayısı sağlanmadı (katılan ${quorum.presentUnits}/${quorum.totalUnits} bölüm; sayı ve arsa payı çoğunluğu gerekli). İkinci toplantıda yeter sayı aranmaz.`,
      );
    }
    if (yes + no + abstain > quorum.presentUnits) {
      throw new ValidationError(`Kabul + ret + çekimser toplamı katılan bölüm sayısını (${quorum.presentUnits}) aşamaz`, 'yes');
    }
    const decision = decide(yes, quorum.presentUnits);
    const tally = { yes, no, abstain, presentUnits: quorum.presentUnits, decision, recordedAt: stamp(), recordedBy: ctx.userId };
    const next: Assembly = {
      ...a,
      agenda: a.agenda.map((i) => (i.itemId === itemId ? { ...i, tally } : i)),
      updatedAt: tally.recordedAt,
      updatedBy: ctx.userId,
      version: a.version + 1,
    };
    const saved = await save(next, a.version, audit(ctx, next, 'assembly.tally', { itemId, yes, no, abstain, presentUnits: quorum.presentUnits, decision, corrected: Boolean(item.tally) }));
    return { assembly: saved, quorum };
  }

  // -------------------------------------------------------------------------
  // Hazirun cetveli (PDF)
  // -------------------------------------------------------------------------

  async function attendanceSheet(ctx: AssemblyContext, id: string) {
    if (!deps.store) throw new DocumentError('unavailable', 'Belge deposu yapılandırılmamış (DOCUMENTS_BUCKET)');
    const a = await requireAssembly(ctx, id);
    const [s, site, blocks] = await Promise.all([state(ctx, a), deps.core.getSite(ctx.apartmentId), deps.core.listBlocks(ctx.apartmentId)]);
    const blockName = new Map(blocks.map((b) => [b.blockId, b.name]));
    const multiBlock = new Set(s.roll.map((r) => r.blockId)).size > 1;
    const units = await rows(ctx, s.roll, s.attendance);
    const apartmentName = site?.name ?? 'Apartman';
    const q = s.quorum;
    const place = [a.location, a.onlineUrl ? `Çevrim içi: ${a.onlineUrl}` : undefined].filter(Boolean).join(' · ');
    const modeText = { present: 'Asaleten', proxy: 'Vekaleten', absent: '' } as const;
    const sheet = {
      title: 'Hazirun Cetveli',
      subtitle: `${KIND_LABELS[a.kind]} Kat Malikleri Kurulu${a.secondMeeting ? ' (ikinci toplantı)' : ''} · ${formatDateTime(a.scheduledAt)} · ${place} · Oy listesi: ${formatDate(a.rollDate)}`,
      sections: [
        {
          columns: [
            { header: 'Sıra', width: 0.45 },
            { header: 'Blok / Daire', width: 1.1 },
            { header: 'Kat maliki (paydaşlar)', width: 3.2 },
            { header: 'Arsa payı', width: 0.9, align: 'right' as const },
            { header: 'Katılım', width: 1 },
            { header: 'Vekil', width: 1.7 },
            { header: 'İmza', width: 1.9 },
          ],
          rowHeight: 26,
          ruled: true,
          rows: [
            ...units.map((u, i) => ({
              cells: [
                String(i + 1),
                multiBlock ? `${blockName.get(u.blockId) ?? 'Blok'} / ${u.number}` : u.number,
                u.owners.length ? u.owners.map((o) => `${o.name ?? 'Kayıtlı kişi'}${o.share ? ` (${shareText(o.share)})` : ''}`).join(', ') : '— (malik kaydı yok)',
                u.landShare ? shareText(u.landShare) : '—',
                u.attendance ? modeText[u.attendance.mode] : '',
                u.attendance?.proxyName ?? '',
                '',
              ],
            })),
            {
              bold: true,
              rule: true,
              cells: ['', `${q.totalUnits} bölüm`, '', q.totalLandShare ? shareText(q.totalLandShare) : '—', `${q.presentUnits} katılan`, `${q.proxyUnits} vekaleten`, ''],
            },
          ],
        },
      ],
      notes: [
        'Toplantı yeter sayısı (KMK m.30): kat maliklerinin sayı ve arsa payı çoğunluğu (her ikisinde yarıdan fazlası); ikinci toplantıda aranmaz. Karar yeter sayısı: katılanların sayı çoğunluğu.',
        `Kayıtlı katılım: ${q.presentUnits}/${q.totalUnits} bölüm${q.presentLandShare ? ` · arsa payı ${shareText(q.presentLandShare)}` : ''} · yeter sayı ${q.met ? 'sağlandı' : 'sağlanmadı'}.`,
        ...q.warnings,
        'Toplantı Başkanı: ..............................   Yazman: ..............................   Oy Toplayıcı: ..............................',
      ],
    };
    const dataHash = createHash('sha256').update(JSON.stringify({ v: 1, apartmentName, assembly: view(a), sheet })).digest('hex');
    const key = assemblySheetKey(ctx.apartmentId, a.rollDate, a.assemblyId, dataHash);
    if (!(await deps.store.head(key))) {
      await deps.store.put(key, await renderReportPdf({ ...sheet, apartmentName, generatedAt: stamp(), dataHash }), 'application/pdf');
    }
    const fileName = `hazirun-cetveli-${a.rollDate}.pdf`;
    const url = await deps.store.presignGet(key, { contentDisposition: contentDisposition(fileName, 'inline'), contentType: 'application/pdf', expiresIn: URL_TTL_SECONDS });
    return { url, fileName, contentType: 'application/pdf', expiresAt: new Date(deps.now().getTime() + URL_TTL_SECONDS * 1000).toISOString() };
  }

  return { create, list, detail, update, cancel, setAttendance, recordTally, attendanceSheet };
}

export type AssemblyService = ReturnType<typeof createAssemblyService>;
