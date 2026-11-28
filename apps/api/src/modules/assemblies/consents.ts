/**
 * Genel kurul sonrasi - toplanti disinda YAZILI RIZA (KMK m.19/2 ve README "Hukuki yorum").
 *
 *  - Talep (karar istegi): baslik, karar turu ve gerekli cogunluk. Yalnizca kanunun yazili rizaya acik
 *    gordugu (m.19/2 "butun kat maliklerinin besde dordunun yazili rizasi") veya yoruma dayali olarak
 *    toplanti disinda imza toplanabilen turler (m.28 yonetim plani: "besde dordunun oyu"; oybirligi
 *    gereken m.24/2, m.42/4, m.44, m.45: butun maliklerin yazili rizasi). Toplanti karari gerektiren
 *    turler (genel karar, isletme projesi, yonetici / denetci secimi, m.42 yenilik) reddedilir.
 *  - Oy listesi talep acilis gununde (Istanbul) DONDURULUR (`ASMCONSROLL#`); sayim yalnizca bundan.
 *  - Riza kaydi bolum basina, DEGISMEZ (`ASMCONSV#<talep>#<bolum>#<sira>`): riza / itiraz, imzalayan
 *    malik (hisseli bolumde temsilci), tarih, yontem, istege bagli taranmis belge (imzali yukleme).
 *    Duzeltme gerekceli yeni sira (`supersedes`); onceki silinmez. Her kayit denetimli.
 *  - Sonuc majority.ts `decideByUnits` ile toplanti kararlariyla AYNI kurallar: riza = kabul, itiraz =
 *    ret, kaydi olmayan bolum = katilmadi; payda dondurulmus listedeki butun kat malikleri (kisi), butun
 *    oylar (m.31 siniri) ve toplam arsa payi. Kapatma sonucu kesinlestirir; sonra kayit eklenmez.
 */
import { createHash } from 'node:crypto';
import { DataAccessError } from '../../config/dynamodb.js';
import type { IsoDate } from '../core/types.js';
import { ValidationError, asObject, assertId, isIsoDate, optString, reqEnum, reqInt, reqString } from '../core/validation.js';
import { DocumentError } from '../documents/errors.js';
import { assemblyConsentReportKey } from '../documents/keys.js';
import type { ReportRow } from '../documents/reportPdf.js';
import { formatDate, formatDateTime } from '../notifications/templates.js';
import { istanbulDate } from '../polls/results.js';
import type { RollEntry } from '../polls/rollSnapshot.js';
import { AssemblyError } from './errors.js';
import {
  DECISION_KINDS,
  DECISION_PRESETS,
  type DecisionKind,
  type DecisionOutcome,
  MAJORITY_LABELS,
  MAJORITY_RULES,
  type MajorityRule,
  type VoteChoice,
  decideByUnits,
  kindLabel,
  landShareMissing,
  unitVotesIssue,
} from './majority.js';
import { pdfSafe, requiredText } from './minutes.js';
import { assemblyKeys } from './repository.js';
import type { AssemblyContext, AssemblyHelpers, AssemblyServiceDeps } from './service.js';
import { CONSENT_CHOICES, CONSENT_METHODS, type ConsentEntry, type ConsentRequest } from './types.js';

/** Toplanti disinda yazili riza ile alinabilen karar turleri ve dayanagi. */
export const CONSENT_KINDS: Partial<Record<DecisionKind, { legal: string; note: string }>> = {
  common_area_change: { legal: 'KMK m.19/2', note: 'Kanun metni "bütün kat maliklerinin beşte dördünün yazılı rızası" der.' },
  management_plan_change: { legal: 'KMK m.28', note: 'Kanun "beşte dördünün oyu" der; imza toplanarak değişiklik yorumdur, teyit edilmeli.' },
  use_change: { legal: 'KMK m.24/2', note: 'Kurulun oybirliğiyle kararı aranır; bütün maliklerin yazılı rızası yorumdur, teyit edilmeli.' },
  central_heating_conversion: { legal: 'KMK m.42/4', note: 'Sayı ve arsa payı olarak oybirliği; bütün maliklerin yazılı rızası yorumdur, teyit edilmeli.' },
  major_disposition: { legal: 'KMK m.45', note: 'Bütün kat maliklerinin oybirliği; yazılı rıza yorumdur, teyit edilmeli.' },
  additional_floor: { legal: 'KMK m.44', note: 'Kurulun oybirliğiyle kararı ve arsa paylarının oybirliğiyle yeniden tespiti; tapu memuru huzurunda resmi senet ayrıca gerekir (m.44/c).' },
  custom: { legal: 'yönetim planı / özel', note: 'Yönetim planındaki hükme dayanır; teyit edilmeli.' },
};

/** Ozel turde secilebilen cogunluklar (toplanti katilanlariyla sayilan `attendees` toplanti disinda anlamsiz). */
const CONSENT_RULES: readonly MajorityRule[] = MAJORITY_RULES.filter((r) => r !== 'attendees');

export const CONSENT_METHOD_LABELS = { wet_signature: 'Islak imza', notarized: 'Noter onaylı', e_signature: 'Nitelikli e-imza', other: 'Diğer' } as const;

const sha256 = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Bolum basina gecerli (en son sirali) kayit. */
export function latestEntries(entries: readonly ConsentEntry[]): ConsentEntry[] {
  const out = new Map<string, ConsentEntry>();
  for (const e of entries) if ((out.get(e.unitId)?.seq ?? 0) < e.seq) out.set(e.unitId, e);
  return [...out.values()].sort((x, y) => x.unitId.localeCompare(y.unitId));
}

/** Sonuc: majority.ts ile ayni kurallar (riza = kabul, itiraz = ret, kaydi olmayan = katilmadi). */
export function consentOutcome(rule: MajorityRule, entries: readonly RollEntry[], meta: ConsentRequest['roll'], latest: readonly ConsentEntry[]): DecisionOutcome {
  const attendance = latest.map((e) => ({ unitId: e.unitId, mode: 'present' as const, attendee: { userId: e.signerUserId } }));
  const votes = new Map<string, VoteChoice>(latest.map((e) => [e.unitId, e.choice === 'consent' ? 'yes' : 'no']));
  const o = decideByUnits({ rule, entries, meta, attendance, votes });
  // Toplanti dilinden yazili riza diline: "katilmadi" = rizasi kaydedilmedi.
  return { ...o, reasons: o.reasons.map((r) => r.replace('bölüm katılmadı', 'bölümün rızası kayıtlı değil').replace('kabul etmedi', 'itiraz etti')) };
}

function reqDate(o: Record<string, unknown>, key: string): IsoDate {
  const v = o[key];
  if (typeof v !== 'string' || !isIsoDate(v)) throw new ValidationError(`${key} YYYY-AA-GG biçiminde bir tarih olmalı`, key);
  return v;
}

export function createConsentService(deps: AssemblyServiceDeps, h: AssemblyHelpers) {
  const repo = deps.repository;
  const today = () => istanbulDate(h.stamp());

  async function requireConsent(ctx: AssemblyContext, consentId: string): Promise<ConsentRequest> {
    assertId(consentId, 'consentId');
    const c = await repo.getConsent(ctx.apartmentId, consentId);
    if (!c || c.apartmentId !== ctx.apartmentId) throw new AssemblyError('not_found', 'Yazılı rıza talebi bulunamadı');
    return c;
  }

  const view = ({ PK: _pk, SK: _sk, ...rest }: ConsentRequest) => rest;
  const entryView = ({ PK: _pk, SK: _sk, document, ...rest }: ConsentEntry) => ({ ...rest, ...(document ? { document: { fileName: document.fileName, contentType: document.contentType, size: document.size } } : {}) });

  const audit = (ctx: AssemblyContext, c: Pick<ConsentRequest, 'consentId'>, action: string, details: Record<string, unknown>, reason?: string) => ({
    apartmentId: ctx.apartmentId,
    action,
    target: { type: 'assembly_consent', id: c.consentId },
    actorId: ctx.userId,
    ...(reason ? { reason } : {}),
    details,
  });

  async function state(ctx: AssemblyContext, c: ConsentRequest) {
    const [entries, all] = await Promise.all([deps.rolls.entries(ctx.apartmentId, 'consent', c.consentId), repo.listConsentEntries(ctx.apartmentId, c.consentId)]);
    const own = all.filter((e) => e.apartmentId === ctx.apartmentId);
    const latest = latestEntries(own);
    return { entries, all: own, latest, outcome: c.status === 'closed' && c.result ? c.result : consentOutcome(c.rule, entries, c.roll, latest) };
  }

  /** Yeni talep: oy listesi bugun icin dondurulur (talep ile ayni atomik yazim). */
  async function createConsent(ctx: AssemblyContext, body: unknown) {
    const o = asObject(body);
    const title = reqString(o, 'title', 300, 3);
    const description = optString(o, 'description', 2000);
    const decisionKind = reqEnum(o, 'decisionKind', DECISION_KINDS);
    const basis = CONSENT_KINDS[decisionKind];
    if (!basis) {
      throw new AssemblyError('unprocessable', `${kindLabel(decisionKind)} kat malikleri kurulunun toplantıdaki kararıyla alınır; toplantı dışında yazılı rızayla kaydedilemez`);
    }
    let rule: MajorityRule;
    if (decisionKind === 'custom') {
      if (typeof o.majority !== 'string' || !(CONSENT_RULES as readonly string[]).includes(o.majority)) throw new ValidationError('Özel türde gerekli çoğunluğu seçin (katılanların oy çokluğu toplantı dışında seçilemez)', 'majority');
      rule = o.majority as MajorityRule;
    } else {
      rule = DECISION_PRESETS[decisionKind].rule;
      if (o.majority !== undefined && o.majority !== null && o.majority !== rule) throw new ValidationError(`${kindLabel(decisionKind)} için gerekli çoğunluk kanundan gelir (${MAJORITY_LABELS[rule]})`, 'majority');
    }
    const now = h.stamp();
    const consentId = `cns-${deps.newId().replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;
    const rollDate = istanbulDate(now);
    const snapshot = await h.snapshot(ctx, 'consent', consentId, rollDate, now);
    const missing = landShareMissing(rule, snapshot.meta);
    if (missing) throw new AssemblyError('unprocessable', `${missing}; önce arsa paylarını girin`);
    if (!snapshot.entries.length) throw new AssemblyError('unprocessable', 'Oy listesinde bağımsız bölüm yok');
    const req: ConsentRequest = {
      ...assemblyKeys.consent(ctx.apartmentId, consentId),
      entityType: 'ASSEMBLY_CONSENT',
      apartmentId: ctx.apartmentId,
      consentId,
      title,
      ...(description ? { description } : {}),
      decisionKind,
      rule,
      rollDate,
      roll: snapshot.meta,
      status: 'open',
      createdAt: now,
      createdBy: ctx.userId,
      updatedAt: now,
      updatedBy: ctx.userId,
      version: 1,
    };
    await repo.createConsent(req, snapshot.chunks, audit(ctx, req, 'assembly.consent_open', { decisionKind, rule, rollDate, units: snapshot.meta.units }));
    return { consent: view(req), legal: basis };
  }

  async function listConsents(ctx: AssemblyContext) {
    const items = (await repo.listConsents(ctx.apartmentId)).filter((c) => c.apartmentId === ctx.apartmentId);
    items.sort((x, y) => y.createdAt.localeCompare(x.createdAt) || y.consentId.localeCompare(x.consentId));
    return { items: items.map(view) };
  }

  /** Ayrinti: bolum bazinda gecerli kayit (imzalayan adi), sonuc (kapaliysa kesinlesen) ve dayanak. */
  async function consentDetail(ctx: AssemblyContext, consentId: string) {
    const c = await requireConsent(ctx, consentId);
    const [s, names] = await Promise.all([state(ctx, c), h.names(ctx)]);
    const latestOf = new Map(s.latest.map((e) => [e.unitId, e]));
    const history = new Map<string, number>();
    for (const e of s.all) history.set(e.unitId, (history.get(e.unitId) ?? 0) + 1);
    const rows = s.entries.map((r) => {
      const e = latestOf.get(r.unitId);
      return {
        unitId: r.unitId,
        blockId: r.blockId,
        number: r.number,
        ...(r.landShare ? { landShare: r.landShare } : {}),
        owners: r.owners.map((o) => ({ userId: o.userId, ...(names.get(o.userId) ? { name: names.get(o.userId) } : {}) })),
        ...(e ? { entry: { ...entryView(e), ...(names.get(e.signerUserId) ? { signerName: names.get(e.signerUserId) } : {}) }, records: history.get(r.unitId) ?? 1 } : {}),
      };
    });
    return { consent: view(c), legal: CONSENT_KINDS[c.decisionKind], outcome: s.outcome, rows };
  }

  /**
   * Bolumun riza / itiraz kaydi (degismez). Bolumde gecerli kayit varsa yalnizca `correctionReason` ile
   * yeni sirali duzeltme. Hisseli bolumde imzalayan paydaslardan biri (temsilci) zorunlu.
   */
  async function recordConsent(ctx: AssemblyContext, consentId: string, unitId: string, body: unknown) {
    const o = asObject(body);
    assertId(unitId, 'unitId');
    const choice = reqEnum(o, 'choice', CONSENT_CHOICES);
    const signedOn = reqDate(o, 'signedOn');
    const method = reqEnum(o, 'method', CONSENT_METHODS);
    const methodNote = optString(o, 'methodNote', 200);
    if (method === 'other' && !methodNote) throw new ValidationError('"Diğer" yöntemde açıklama girin', 'methodNote');
    if (signedOn > today()) throw new ValidationError('İmza tarihi bugünden sonra olamaz', 'signedOn');
    const c = await requireConsent(ctx, consentId);
    if (c.status !== 'open') throw new AssemblyError('conflict', c.status === 'closed' ? 'Talep kapatıldı; sonuç kesinleşti' : 'Talep iptal edildi');
    const s = await state(ctx, c);
    const entry = s.entries.find((e) => e.unitId === unitId);
    if (!entry) throw new AssemblyError('not_found', 'Bölüm talebin oy listesinde yok');
    const signerUserId = o.signerUserId === undefined || o.signerUserId === null || o.signerUserId === '' ? undefined : assertId(o.signerUserId, 'signerUserId');
    if (entry.owners.length > 1 && !signerUserId) throw new ValidationError('Hisseli bölümde rızayı veren paydaşı (temsilci) seçin', 'signerUserId');
    const signer = signerUserId ?? entry.owners[0]?.userId;
    if (!signer) throw new AssemblyError('unprocessable', 'Bölümün oy listesinde maliki yok');
    if (!entry.owners.some((x) => x.userId === signer)) throw new ValidationError('İmzalayan bu bölümün malikleri arasında değil', 'signerUserId');
    const existing = s.latest.find((e) => e.unitId === unitId);
    if (existing && (o.correctionReason === undefined || o.correctionReason === null)) {
      throw new AssemblyError('conflict', 'Bu bölümün rıza kaydı var ve değiştirilemez; düzeltme gerekçesiyle yeni kayıt olarak eklenir');
    }
    if (!existing && o.correctionReason !== undefined) throw new ValidationError('Düzeltme gerekçesi yalnızca kayıtlı bölüm için girilir', 'correctionReason');
    const correctionReason = existing ? reqString(o, 'correctionReason', 500, 3) : undefined;
    // Ayni kisinin / malikin bolumleri ayni yonde olmali (majority.ts kurali).
    const after = [...s.latest.filter((e) => e.unitId !== unitId), { unitId, signerUserId: signer, choice } as ConsentEntry];
    const issue = unitVotesIssue(
      s.entries,
      after.map((e) => ({ unitId: e.unitId, mode: 'present' as const, attendee: { userId: e.signerUserId } })),
      new Map(after.map((e) => [e.unitId, e.choice])),
      c.rule,
    );
    if (issue) throw new AssemblyError('unprocessable', issue.replace('aynı oyu', 'aynı yönde rıza / itirazı').replace('toplantıya katılmadı; oyu girilemez', 'kayıtlı değil'));
    let document: ConsentEntry['document'];
    if (o.document !== undefined && o.document !== null) {
      if (!deps.documents) throw new DocumentError('unavailable', 'Belge deposu yapılandırılmamış (DOCUMENTS_BUCKET)');
      const d = asObject(o.document, 'document');
      document = await deps.documents.promote(ctx.apartmentId, { uploadId: assertId(d.uploadId, 'document.uploadId'), fileName: reqString(d, 'fileName', 255) }, { consentId, unitId });
    }
    const seq = (existing?.seq ?? 0) + 1;
    const now = h.stamp();
    const rec: ConsentEntry = {
      ...assemblyKeys.consentEntry(ctx.apartmentId, consentId, unitId, seq),
      entityType: 'ASSEMBLY_CONSENT_ENTRY',
      apartmentId: ctx.apartmentId,
      consentId,
      unitId,
      seq,
      choice,
      signerUserId: signer,
      signedOn,
      method,
      ...(methodNote ? { methodNote } : {}),
      ...(document ? { document } : {}),
      ...(existing ? { supersedes: existing.seq, correctionReason } : {}),
      recordedAt: now,
      recordedBy: ctx.userId,
    };
    try {
      await repo.putConsentEntry(
        rec,
        audit(ctx, c, existing ? 'assembly.consent_correction' : 'assembly.consent_record', { unitId, seq, choice, method, signedOn, document: Boolean(document), ...(existing ? { supersedes: existing.seq } : {}) }, correctionReason),
      );
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') throw new AssemblyError('conflict', 'Kayıt bu arada değişti veya talep kapatıldı; sayfayı yenileyin');
      throw err;
    }
    const latest = [...s.latest.filter((e) => e.unitId !== unitId), rec];
    return { entry: entryView(rec), outcome: consentOutcome(c.rule, s.entries, c.roll, latest) };
  }

  /** Talebi kapatir: sonuc kesinlesir (talep kaydina yazilir), sonra riza kaydi eklenmez. */
  async function closeConsent(ctx: AssemblyContext, consentId: string, body: unknown) {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const c = await requireConsent(ctx, consentId);
    if (c.version !== version) throw new AssemblyError('conflict', 'Kayıt başka bir işlemle değişti (sürüm uyuşmazlığı)');
    if (c.status !== 'open') throw new AssemblyError('conflict', 'Yalnızca açık talep kapatılabilir');
    const s = await state(ctx, c);
    const now = h.stamp();
    const next: ConsentRequest = { ...c, status: 'closed', result: s.outcome, closedAt: now, closedBy: ctx.userId, updatedAt: now, updatedBy: ctx.userId, version: c.version + 1 };
    const entriesHash = sha256(s.latest.map((e) => [e.unitId, e.seq, e.choice]));
    await saveConsent(next, version, audit(ctx, c, 'assembly.consent_close', { decision: s.outcome.decision, rule: c.rule, records: s.latest.length, persons: s.outcome.persons, units: s.outcome.units, entriesHash }));
    return { consent: view(next), outcome: s.outcome };
  }

  async function cancelConsent(ctx: AssemblyContext, consentId: string, body: unknown) {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const reason = reqString(o, 'reason', 500, 3);
    const c = await requireConsent(ctx, consentId);
    if (c.version !== version) throw new AssemblyError('conflict', 'Kayıt başka bir işlemle değişti (sürüm uyuşmazlığı)');
    if (c.status !== 'open') throw new AssemblyError('conflict', 'Yalnızca açık talep iptal edilebilir');
    const now = h.stamp();
    const next: ConsentRequest = { ...c, status: 'cancelled', cancelledAt: now, cancelReason: reason, updatedAt: now, updatedBy: ctx.userId, version: c.version + 1 };
    await saveConsent(next, version, audit(ctx, c, 'assembly.consent_cancel', {}, reason));
    return { consent: view(next) };
  }

  async function saveConsent(next: ConsentRequest, version: number, draft: ReturnType<typeof audit>) {
    try {
      await repo.updateConsent(next, version, draft);
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') throw new AssemblyError('conflict', 'Kayıt başka bir işlemle değişti (sürüm uyuşmazlığı)');
      throw err;
    }
  }

  /** Bolumun riza belgesi (5 dk imzali link). `seq` verilmezse gecerli kayit. */
  async function consentDocument(ctx: AssemblyContext, consentId: string, unitId: string, seqParam?: string) {
    assertId(unitId, 'unitId');
    const c = await requireConsent(ctx, consentId);
    const all = (await repo.listConsentEntries(ctx.apartmentId, c.consentId)).filter((e) => e.unitId === unitId);
    if (seqParam !== undefined && !/^\d{1,3}$/.test(seqParam)) throw new ValidationError('seq geçersiz', 'seq');
    const e = seqParam === undefined ? latestEntries(all)[0] : all.find((x) => x.seq === Number(seqParam));
    if (!e?.document) throw new AssemblyError('not_found', 'Rıza belgesi bulunamadı');
    if (!deps.documents) throw new DocumentError('unavailable', 'Belge deposu yapılandırılmamış (DOCUMENTS_BUCKET)');
    return deps.documents.sign(ctx.apartmentId, e.document);
  }

  /** Sonuc tutanagi PDF'i (okuma; acik talepte "ara sonuc"). */
  async function consentPdf(ctx: AssemblyContext, consentId: string) {
    const store = h.requireStore();
    const c = await requireConsent(ctx, consentId);
    const [s, names, site, blocks] = await Promise.all([state(ctx, c), h.names(ctx), deps.core.getSite(ctx.apartmentId), deps.core.listBlocks(ctx.apartmentId)]);
    const blockName = new Map(blocks.map((b) => [b.blockId, b.name]));
    const multiBlock = new Set(s.entries.map((r) => r.blockId)).size > 1;
    const latestOf = new Map(s.latest.map((e) => [e.unitId, e]));
    const o = s.outcome;
    const interim = c.status !== 'closed';
    const choiceText = { consent: 'Rıza', object: 'İtiraz' } as const;
    const rows: ReportRow[] = s.entries.map((r, i) => {
      const e = latestOf.get(r.unitId);
      return {
        cells: [
          String(i + 1),
          multiBlock ? `${blockName.get(r.blockId) ?? 'Blok'} / ${r.number}` : r.number,
          pdfSafe(r.owners.map((x) => names.get(x.userId) ?? 'Kayıtlı kişi').join(', ') || '—'),
          e ? choiceText[e.choice] : 'Kayıt yok',
          e ? pdfSafe(names.get(e.signerUserId) ?? 'Kayıtlı kişi') : '',
          e ? formatDate(e.signedOn) : '',
          e ? `${CONSENT_METHOD_LABELS[e.method]}${e.document ? ' · belge' : ''}${e.seq > 1 ? ' · düzeltildi' : ''}` : '',
        ],
      };
    });
    const basis = CONSENT_KINDS[c.decisionKind];
    const content = {
      apartmentName: site?.name ?? 'Apartman',
      title: interim ? 'Yazılı Rıza Durumu (ara sonuç)' : 'Yazılı Rıza Sonuç Tutanağı',
      subtitle: pdfSafe(`${c.title} · ${kindLabel(c.decisionKind)} (${basis?.legal ?? ''}) · Oy listesi: ${formatDate(c.rollDate)}`),
      sections: [
        {
          columns: [
            { header: 'Sıra', width: 0.45 },
            { header: 'Blok / Daire', width: 1.1 },
            { header: 'Kat maliki', width: 2.6 },
            { header: 'Beyan', width: 0.9 },
            { header: 'İmzalayan', width: 1.8 },
            { header: 'Tarih', width: 1 },
            { header: 'Yöntem', width: 1.6 },
          ],
          rows,
        },
        {
          title: 'Sonuç',
          paragraphs: [
            `Gerekli çoğunluk: ${MAJORITY_LABELS[c.rule]} · ${requiredText(o)}`,
            `Rıza: ${o.persons?.yes ?? 0} kat maliki (kişi), ${o.votes.yes} oy, ${o.units?.yes ?? 0} bölüm${o.landShareBps ? `, arsa payı %${(o.landShareBps.yes / 100).toFixed(2).replace('.', ',')}` : ''} · İtiraz: ${o.persons?.no ?? 0} kişi, ${o.units?.no ?? 0} bölüm · Kaydı olmayan: ${o.units?.absent ?? 0} bölüm`,
            `Sonuç: ${o.decision === 'accepted' ? 'GEREKLİ ÇOĞUNLUK SAĞLANDI' : 'GEREKLİ ÇOĞUNLUK SAĞLANMADI'}${interim ? ' (ara sonuç; talep kapatılmadı)' : ` · kapanış ${formatDateTime(c.closedAt)}`}`,
            ...o.reasons.map((r) => `Gerekçe: ${r}`),
            ...o.warnings,
            ...(c.description ? [pdfSafe(c.description)] : []),
          ],
          columns: [],
          rows: [],
        },
      ],
      notes: [
        basis ? `Dayanak: ${basis.legal}. ${basis.note}` : '',
        'Sayım toplantı kararlarıyla aynı kurallarla yapılır: payda talebin açıldığı gün dondurulan oy listesindeki bütün kat malikleri (kişi), bütün oylar (KMK m.31 kişi sınırı) ve toplam arsa payı; kaydı olmayan bölüm rıza vermemiş sayılır. Hesap yorumları avukat onayı bekler.',
        'Rıza kayıtları değişmezdir; düzeltme gerekçeli yeni kayıttır. Islak imzalı / noter onaylı belgelerin asılları saklanmalıdır; bu döküm onların yerine geçmez.',
      ].filter(Boolean),
    };
    const key = await h.cachedPdf(store, (hash) => assemblyConsentReportKey(ctx.apartmentId, c.rollDate, c.consentId, hash), content);
    return { ...(await h.signed(store, key, `yazili-riza-${c.rollDate}-${c.consentId}${interim ? '-ara' : ''}.pdf`)), interim };
  }

  return { createConsent, listConsents, consentDetail, recordConsent, closeConsent, cancelConsent, consentDocument, consentPdf };
}
