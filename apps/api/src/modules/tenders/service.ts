/**
 * Ihale / teklif toplama servisi: buyuk tadilat / bakim islerinde alinan tekliflerin sakinlerle
 * seffafca paylasilmasi.
 *
 *  - Kiraci izolasyonu: apartman ve aktor JWT claim'lerinden; istek govdesindeki kimlik kullanilmaz.
 *  - Yazma: `apartment_manager`, `management_company`. Denetci (`observer`) ve sakin yalnizca
 *    yayinlanmis (sakinlerle paylasilmis) ihaleleri gorur; taslak / teklif toplama asamasi yonetimde kalir.
 *  - Durumlar: draft -> collecting -> published -> decided; draft / collecting / published -> cancelled.
 *    Silme yok. Tum yonetim islemleri denetim gunlugune (`tender.*`) ayni atomik yazimda.
 *  - Teklif belgesi: gider faturasi yukleme akisi (gecici `tmp/` -> kalici `apartments/{apt}/tenders/...`),
 *    indirme yalnizca kisa omurlu imzali URL ile.
 *  - Karsilastirma KDV dahil toplam uzerinden (model.ts); karar aninda secilen teklifin ozeti saklanir.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { IsoDate } from '../core/types.js';
import { type Obj, ValidationError, asObject, assertId, isIsoDate, reqEnum, reqInt, reqString } from '../core/validation.js';
import type { SignedDownload } from '../documents/service.js';
import { type PortalRepository, portalRepository } from '../portal/repository.js';
import { istanbulDate } from '../reservations/time.js';
import { type TicketRepository, ticketRepository } from '../tickets/repository.js';
import { TenderError } from './errors.js';
import { compareQuotes, isShared, nextStatus, normalizeQuote, publishReadiness, type TenderAction } from './model.js';
import { TenderConflictError, type TenderRepository, type TenderWrite, tenderRepository } from './repository.js';
import {
  CANCELLABLE_STATUSES,
  DEFAULT_MIN_QUOTES,
  EDITABLE_STATUSES,
  MAX_COMMENT_LENGTH,
  MAX_COMMENTS_PER_USER,
  MAX_DELIVERY_DAYS,
  MAX_MIN_QUOTES,
  MAX_QUOTE_KURUS,
  MAX_QUOTES,
  MAX_VAT_RATE,
  MAX_WARRANTY_MONTHS,
  TENDER_CATEGORIES,
  TENDER_STATUSES,
  type QuoteDocument,
  type Tender,
  type TenderComment,
  type TenderQuote,
  type TenderStatus,
  type TenderTicketLink,
  tenderKeys,
} from './types.js';

export type TenderContext = { apartmentId: string; userId: string; role: string };

/** Belge deposu baglantisi (documents servisi): gecici yuklemeyi tasima ve imzali indirme linki. */
export type TenderDocuments = {
  promote(apartmentId: string, upload: { uploadId: string; fileName: string }, target: { tenderId: string; quoteId: string }): Promise<QuoteDocument>;
  sign(apartmentId: string, doc: QuoteDocument): Promise<SignedDownload>;
};

export type TenderServiceDeps = {
  repo: TenderRepository;
  /** Verilmezse (belge deposu yok) teklif belgesi eklenemez / acilamaz (503). */
  documents: TenderDocuments | undefined;
  tickets: Pick<TicketRepository, 'get'>;
  memberships: Pick<PortalRepository, 'listMemberships'>;
  now: () => Date;
  newId: () => string;
};

type Audience = 'manager' | 'observer' | 'resident';

const MANAGER_ROLES = new Set(['apartment_manager', 'management_company']);
const WRITE_RETRIES = 3;
const STATUS_ORDER: Record<TenderStatus, number> = { published: 0, collecting: 1, draft: 2, decided: 3, cancelled: 4 };

const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

type TenderFields = Pick<Tender, 'title' | 'description' | 'category' | 'minQuotes' | 'deadline'>;
const TENDER_FIELDS = ['title', 'description', 'category', 'minQuotes', 'deadline'] as const satisfies readonly (keyof TenderFields)[];

type QuoteFields = Pick<TenderQuote, 'supplierName' | 'amountKurus' | 'vatIncluded' | 'vatRate' | 'validUntil' | 'deliveryDays' | 'warrantyMonths' | 'notes'>;
const QUOTE_FIELDS = ['supplierName', 'amountKurus', 'vatIncluded', 'vatRate', 'validUntil', 'deliveryDays', 'warrantyMonths', 'notes'] as const satisfies readonly (keyof QuoteFields)[];

export function createTenderService(overrides: Partial<TenderServiceDeps> = {}) {
  const deps: TenderServiceDeps = {
    repo: tenderRepository,
    documents: undefined,
    tickets: ticketRepository,
    memberships: portalRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.repo;
  const stamp = () => deps.now().toISOString();
  const today = (): IsoDate => istanbulDate(deps.now());
  const shortId = (n = 12) => deps.newId().replace(/[^A-Za-z0-9]/g, '').slice(0, n);

  // -------------------------------------------------------------------------
  // Aktor
  // -------------------------------------------------------------------------

  function audienceOf(ctx: TenderContext): Audience {
    if (MANAGER_ROLES.has(ctx.role)) return 'manager';
    if (ctx.role === 'observer') return 'observer';
    if (ctx.role === 'resident') return 'resident';
    throw new TenderError('forbidden', 'Bu rol ihale modülünü kullanamaz');
  }

  function managerOf(ctx: TenderContext) {
    if (audienceOf(ctx) !== 'manager') throw new TenderError('forbidden', 'Bu işlem yalnızca yönetim tarafından yapılabilir');
  }

  function staffOf(ctx: TenderContext): Exclude<Audience, 'resident'> {
    const a = audienceOf(ctx);
    if (a === 'resident') throw new TenderError('forbidden', 'Bu ekran yönetim ekranıdır');
    return a;
  }

  /** Sakin: bu apartmanda bugun gecerli bir uyeligi olmali (tasinan sakin, token suresi dolmadan da goremez). */
  async function residentOf(ctx: TenderContext) {
    if (audienceOf(ctx) !== 'resident') throw new TenderError('forbidden', 'Bu ekran sakin portalıdır');
    const d = today();
    const member = (await deps.memberships.listMemberships(ctx.apartmentId, ctx.userId)).some(
      (m) => m.apartmentId === ctx.apartmentId && m.status === 'active' && m.startDate <= d && (!m.endDate || m.endDate >= d),
    );
    if (!member) throw new TenderError('forbidden', 'İhaleleri görmek için bu sitede güncel bir daire üyeliğiniz olmalı');
  }

  function requireDocuments(): TenderDocuments {
    if (!deps.documents) throw new TenderError('unavailable', 'Belge deposu yapılandırılmamış (DOCUMENTS_BUCKET)');
    return deps.documents;
  }

  // -------------------------------------------------------------------------
  // Dogrulama
  // -------------------------------------------------------------------------

  function reqDate(o: Obj, key: string): IsoDate {
    const v = o[key];
    if (typeof v !== 'string' || !isIsoDate(v)) throw new ValidationError(`${key} YYYY-AA-GG biçiminde bir tarih olmalı`, key);
    return v;
  }

  function optDate(o: Obj, key: string): IsoDate | undefined {
    return o[key] === undefined || o[key] === null || o[key] === '' ? undefined : reqDate(o, key);
  }

  function optText(o: Obj, key: string, max: number): string | undefined {
    const v = o[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw new ValidationError(`${key} metin olmalı`, key);
    const text = v.trim();
    if (text.length > max) throw new ValidationError(`${key} en fazla ${max} karakter olabilir`, key);
    return text || undefined;
  }

  function optIntOrNull(o: Obj, key: string, min: number, max: number): number | undefined {
    return o[key] === undefined || o[key] === null ? undefined : reqInt(o, key, min, max);
  }

  function reqReason(o: Obj, key: string, min: number, max: number): string {
    const v = o[key];
    if (typeof v !== 'string' || v.trim().length < min) throw new ValidationError(`Gerekçe en az ${min} karakter olmalı`, key);
    const text = v.trim();
    if (text.length > max) throw new ValidationError(`Gerekçe en fazla ${max} karakter olabilir`, key);
    return text;
  }

  const parseVersion = (o: Obj) => reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);

  /** Ihale alanlari; verilmeyenler `current`ten (guncelleme) veya varsayilandan. */
  function readTender(o: Obj, current?: TenderFields): TenderFields {
    const has = (k: string) => o[k] !== undefined;
    const title = has('title') || !current ? reqString(o, 'title', 120, 3) : current.title;
    const description = has('description') || !current ? reqString(o, 'description', 4000, 10) : current.description;
    const category = has('category') || !current ? reqEnum(o, 'category', TENDER_CATEGORIES) : current.category;
    const minQuotes = has('minQuotes') ? reqInt(o, 'minQuotes', 1, MAX_MIN_QUOTES) : (current?.minQuotes ?? DEFAULT_MIN_QUOTES);
    const deadline = has('deadline') || !current ? reqDate(o, 'deadline') : current.deadline;
    if ((!current || deadline !== current.deadline) && deadline < today()) throw new ValidationError('Son teklif tarihi bugünden önce olamaz', 'deadline');
    return { title, description, category, minQuotes, deadline };
  }

  /** Ilgili talep: ayni apartmanda var olmali; numara ve baslik gosterim icin saklanir. `null` bagi kaldirir. */
  async function readTicket(ctx: TenderContext, o: Obj, current?: TenderTicketLink): Promise<TenderTicketLink | undefined> {
    if (o.ticketId === undefined) return current;
    if (o.ticketId === null || o.ticketId === '') return undefined;
    const ticketId = assertId(o.ticketId, 'ticketId');
    if (current?.ticketId === ticketId) return current;
    const ticket = await deps.tickets.get(ctx.apartmentId, ticketId);
    if (!ticket || ticket.apartmentId !== ctx.apartmentId) throw new TenderError('not_found', 'İlgili talep bulunamadı');
    return { ticketId, number: ticket.number, title: ticket.title };
  }

  function readQuote(o: Obj, current?: QuoteFields): QuoteFields {
    const has = (k: string) => o[k] !== undefined;
    const supplierName = has('supplierName') || !current ? reqString(o, 'supplierName', 120, 2) : current.supplierName;
    const amountKurus = has('amountKurus') || !current ? reqInt(o, 'amountKurus', 1, MAX_QUOTE_KURUS) : current.amountKurus;
    let vatIncluded = current?.vatIncluded;
    if (has('vatIncluded') || !current) {
      if (typeof o.vatIncluded !== 'boolean') throw new ValidationError('vatIncluded true/false olmalı (KDV dahil mi?)', 'vatIncluded');
      vatIncluded = o.vatIncluded;
    }
    const vatRate = has('vatRate') || !current ? reqInt(o, 'vatRate', 0, MAX_VAT_RATE) : current.vatRate;
    const validUntil = has('validUntil') ? optDate(o, 'validUntil') : current?.validUntil;
    const deliveryDays = has('deliveryDays') ? optIntOrNull(o, 'deliveryDays', 1, MAX_DELIVERY_DAYS) : current?.deliveryDays;
    const warrantyMonths = has('warrantyMonths') ? optIntOrNull(o, 'warrantyMonths', 0, MAX_WARRANTY_MONTHS) : current?.warrantyMonths;
    const notes = has('notes') ? optText(o, 'notes', 1000) : current?.notes;
    return {
      supplierName,
      amountKurus,
      vatIncluded: vatIncluded as boolean,
      vatRate,
      ...(validUntil ? { validUntil } : {}),
      ...(deliveryDays !== undefined ? { deliveryDays } : {}),
      ...(warrantyMonths !== undefined ? { warrantyMonths } : {}),
      ...(notes ? { notes } : {}),
    };
  }

  function readUpload(o: Obj): { uploadId: string; fileName: string } | undefined {
    if (o.document === undefined || o.document === null) return undefined;
    const d = asObject(o.document, 'document');
    return { uploadId: assertId(d.uploadId, 'document.uploadId'), fileName: reqString(d, 'fileName', 255) };
  }

  // -------------------------------------------------------------------------
  // Gorunumler
  // -------------------------------------------------------------------------

  function quoteView(q: TenderQuote, audience: Audience) {
    const { document, createdBy, updatedBy, withdrawnBy, ...rest } = q;
    return {
      ...rest,
      ...normalizeQuote(q),
      ...(document ? { document: { fileName: document.fileName, contentType: document.contentType, size: document.size } } : {}),
      ...(audience === 'resident' ? {} : { createdBy, updatedBy, ...(withdrawnBy ? { withdrawnBy } : {}) }),
    };
  }

  function decisionView(t: Tender, audience: Audience) {
    if (!t.decision) return {};
    const { decidedBy, ...rest } = t.decision;
    return { decision: audience === 'resident' ? rest : t.decision };
  }

  function summaryView(t: Tender, audience: Audience) {
    const comparison = compareQuotes(t.quotes);
    return {
      tenderId: t.tenderId,
      title: t.title,
      category: t.category,
      status: t.status,
      deadline: t.deadline,
      deadlinePassed: t.deadline < today(),
      minQuotes: t.minQuotes,
      quoteCount: comparison.rows.length,
      ...(comparison.lowestTotalKurus !== undefined ? { lowestTotalKurus: comparison.lowestTotalKurus } : {}),
      ...(t.ticket ? { ticket: t.ticket } : {}),
      ...(t.publishedAt ? { publishedAt: t.publishedAt } : {}),
      ...decisionView(t, audience),
      ...(t.cancelledAt ? { cancelledAt: t.cancelledAt } : {}),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      version: t.version,
    };
  }

  function commentView(c: TenderComment, ctx: TenderContext, audience: Audience) {
    return {
      commentId: c.commentId,
      body: c.body,
      authorKind: c.authorKind,
      mine: c.authorId === ctx.userId,
      createdAt: c.createdAt,
      // KVKK: sakinler birbirinin kimligini gormez; yonetim / denetci yazar kimligini gorur.
      ...(audience === 'resident' ? {} : { authorId: c.authorId, authorRole: c.authorRole }),
    };
  }

  async function detailView(ctx: TenderContext, t: Tender, audience: Audience) {
    const comments = isShared(t) ? await repo.listComments(ctx.apartmentId, t.tenderId) : [];
    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      ...summaryView(t, audience),
      description: t.description,
      ...(t.shortfallReason ? { shortfallReason: t.shortfallReason } : {}),
      ...(t.cancelReason ? { cancelReason: t.cancelReason, cancelledFrom: t.cancelledFrom } : {}),
      quotes: t.quotes.map((q) => quoteView(q, audience)),
      comparison: compareQuotes(t.quotes),
      comments: comments.map((c) => commentView(c, ctx, audience)),
      canComment: t.status === 'published' && audience !== 'observer',
      ...(audience === 'manager'
        ? { readiness: publishReadiness(t), createdBy: t.createdBy, updatedBy: t.updatedBy, ...(t.publishedBy ? { publishedBy: t.publishedBy } : {}), ...(t.cancelledBy ? { cancelledBy: t.cancelledBy } : {}) }
        : {}),
    };
  }

  const sortTenders = (items: Tender[]) =>
    items.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt.localeCompare(a.updatedAt));

  // -------------------------------------------------------------------------
  // Okuma
  // -------------------------------------------------------------------------

  async function load(ctx: TenderContext, tenderId: string): Promise<Tender> {
    assertId(tenderId, 'tenderId');
    const t = await repo.get(ctx.apartmentId, tenderId);
    if (!t || t.apartmentId !== ctx.apartmentId) throw new TenderError('not_found', 'İhale bulunamadı');
    return t;
  }

  /** Denetci / sakin: paylasilmamis ihale yokmus gibi (404; varligi sizdirilmaz). */
  async function loadVisible(ctx: TenderContext, tenderId: string, audience: Audience): Promise<Tender> {
    const t = await load(ctx, tenderId);
    if (audience !== 'manager' && !isShared(t)) throw new TenderError('not_found', 'İhale bulunamadı');
    return t;
  }

  async function list(ctx: TenderContext, q: { status?: string } = {}) {
    const audience = staffOf(ctx);
    if (q.status !== undefined && !(TENDER_STATUSES as readonly string[]).includes(q.status)) throw new ValidationError('Geçersiz durum filtresi', 'status');
    const items = (await repo.list(ctx.apartmentId)).filter((t) => (audience === 'manager' || isShared(t)) && (!q.status || t.status === q.status));
    return { items: sortTenders(items).map((t) => summaryView(t, audience)) };
  }

  async function get(ctx: TenderContext, tenderId: string) {
    const audience = staffOf(ctx);
    return { tender: await detailView(ctx, await loadVisible(ctx, tenderId, audience), audience) };
  }

  async function portalList(ctx: TenderContext) {
    await residentOf(ctx);
    const items = (await repo.list(ctx.apartmentId)).filter(isShared);
    return { items: sortTenders(items).map((t) => summaryView(t, 'resident')) };
  }

  async function portalGet(ctx: TenderContext, tenderId: string) {
    await residentOf(ctx);
    return { tender: await detailView(ctx, await loadVisible(ctx, tenderId, 'resident'), 'resident') };
  }

  /**
   * Teklif belgesi (5 dk imzali link). Yonetim her asamada; denetci ve sakin yalnizca yayinlanmis
   * (paylasilmis) ihalede - aksi halde 404.
   */
  async function documentFor(ctx: TenderContext, tenderId: string, quoteId: string, audience: Audience) {
    const t = await loadVisible(ctx, tenderId, audience);
    assertId(quoteId, 'quoteId');
    const quote = t.quotes.find((q) => q.quoteId === quoteId);
    if (!quote?.document) throw new TenderError('not_found', 'Teklif belgesi bulunamadı');
    return requireDocuments().sign(ctx.apartmentId, quote.document);
  }

  const quoteDocument = (ctx: TenderContext, tenderId: string, quoteId: string) => documentFor(ctx, tenderId, quoteId, staffOf(ctx));
  async function portalQuoteDocument(ctx: TenderContext, tenderId: string, quoteId: string) {
    await residentOf(ctx);
    return documentFor(ctx, tenderId, quoteId, 'resident');
  }

  // -------------------------------------------------------------------------
  // Yazim yardimcilari
  // -------------------------------------------------------------------------

  async function write(ctx: TenderContext, w: TenderWrite) {
    try {
      await repo.write(ctx.apartmentId, w);
    } catch (err) {
      if (err instanceof TenderConflictError) {
        if (err.reason === 'status') throw new TenderError('invalid_state', 'İhale artık yorumlara açık değil');
        throw new TenderError('conflict', 'İhale başka bir işlemle değişti; sayfayı yenileyin');
      }
      throw err;
    }
  }

  function assertVersion(t: Tender, version: number) {
    if (t.version !== version) throw new TenderError('conflict', 'İhale başka bir işlemle değişti; sayfayı yenileyin');
  }

  function assertEditable(t: Tender) {
    if (!EDITABLE_STATUSES.includes(t.status)) throw new TenderError('invalid_state', 'Yayınlanan, karara bağlanan veya iptal edilen ihalenin teklifleri değiştirilemez');
  }

  const touch = (ctx: TenderContext, t: Tender, ts: string) => ({ updatedAt: ts, updatedBy: ctx.userId, version: t.version + 1 });
  const audit = (ctx: TenderContext, action: string, tenderId: string, details: Record<string, unknown>, reason?: string) => ({
    apartmentId: ctx.apartmentId,
    action,
    target: { type: 'tender', id: tenderId },
    ...(reason ? { reason } : {}),
    details,
  });

  /** Idempotent olusturma: ayni anahtar + ayni icerik ayni kaydi doner, farkli icerik 409. */
  async function replayOf(ctx: TenderContext, key: string, kind: 'tender' | 'quote' | 'comment', fp: string) {
    const idem = await repo.getIdempotency(ctx.apartmentId, key);
    if (!idem) return undefined;
    if (idem.kind !== kind || idem.fingerprint !== fp) throw new TenderError('conflict', 'Bu idempotencyKey farklı bir istek için kullanılmış');
    return idem;
  }

  const idempotency = (ctx: TenderContext, key: string, kind: 'tender' | 'quote' | 'comment', tenderId: string, targetId: string, fp: string, ts: string) => ({
    ...tenderKeys.idempotency(ctx.apartmentId, key),
    entityType: 'TENDER_IDEMPOTENCY' as const,
    apartmentId: ctx.apartmentId,
    kind,
    tenderId,
    targetId,
    fingerprint: fp,
    createdAt: ts,
  });

  // -------------------------------------------------------------------------
  // Ihale (yonetim)
  // -------------------------------------------------------------------------

  /** Yeni ihale (taslak). `idempotencyKey` ayni istegin tekrarini ikinci ihaleye cevirmez. */
  async function create(ctx: TenderContext, body: unknown) {
    managerOf(ctx);
    const o = asObject(body);
    const key = assertId(o.idempotencyKey, 'idempotencyKey');
    const fields = readTender(o);
    const ticketId = o.ticketId === undefined || o.ticketId === null || o.ticketId === '' ? undefined : assertId(o.ticketId, 'ticketId');
    const fp = fingerprint({ kind: 'tender', ...fields, ticketId });
    const replay = async () => {
      const idem = await replayOf(ctx, key, 'tender', fp);
      if (!idem) return undefined;
      const t = await repo.get(ctx.apartmentId, idem.tenderId);
      if (!t) throw new TenderError('conflict', 'İhale oluşturma sürüyor; tekrar deneyin');
      return { tender: await detailView(ctx, t, 'manager'), replayed: true };
    };
    const prior = await replay();
    if (prior) return prior;
    const ticket = await readTicket(ctx, o);
    const ts = stamp();
    const tenderId = `tnd-${shortId()}`;
    const tender: Tender = {
      ...tenderKeys.tender(ctx.apartmentId, tenderId),
      entityType: 'TENDER',
      apartmentId: ctx.apartmentId,
      tenderId,
      ...fields,
      ...(ticket ? { ticket } : {}),
      status: 'draft',
      quotes: [],
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    try {
      await repo.write(ctx.apartmentId, {
        tender: { item: tender, expectedVersion: 0 },
        idempotency: idempotency(ctx, key, 'tender', tenderId, tenderId, fp, ts),
        audit: audit(ctx, 'tender.create', tenderId, { title: fields.title, category: fields.category, minQuotes: fields.minQuotes, deadline: fields.deadline, ...(ticket ? { ticketId: ticket.ticketId } : {}) }),
      });
    } catch (err) {
      if (err instanceof TenderConflictError && err.reason === 'duplicate') {
        const r = await replay();
        if (r) return r;
      }
      if (err instanceof TenderConflictError) throw new TenderError('conflict', err.message);
      throw err;
    }
    return { tender: await detailView(ctx, tender, 'manager'), replayed: false };
  }

  /** Taslak / teklif toplama asamasinda bilgi duzeltme (surumlu). */
  async function update(ctx: TenderContext, tenderId: string, body: unknown) {
    managerOf(ctx);
    const o = asObject(body);
    const version = parseVersion(o);
    const t = await load(ctx, tenderId);
    if (!EDITABLE_STATUSES.includes(t.status)) throw new TenderError('invalid_state', 'Yalnızca taslak veya teklif toplanan ihale düzenlenebilir');
    assertVersion(t, version);
    const fields = readTender(o, t);
    const ticket = await readTicket(ctx, o, t.ticket);
    const changed: string[] = TENDER_FIELDS.filter((k) => fields[k] !== t[k]);
    if ((ticket?.ticketId ?? null) !== (t.ticket?.ticketId ?? null)) changed.push('ticketId');
    if (!changed.length) return { tender: await detailView(ctx, t, 'manager') };
    const ts = stamp();
    const { ticket: _old, ...base } = t;
    const next: Tender = { ...base, ...fields, ...(ticket ? { ticket } : {}), ...touch(ctx, t, ts) };
    await write(ctx, { tender: { item: next, expectedVersion: version }, audit: audit(ctx, 'tender.update', tenderId, { fields: changed }) });
    return { tender: await detailView(ctx, next, 'manager') };
  }

  async function transition(ctx: TenderContext, tenderId: string, action: TenderAction, body: unknown, build: (t: Tender, o: Obj, ts: string) => { next: Partial<Tender>; details: Record<string, unknown>; reason?: string }) {
    managerOf(ctx);
    const o = asObject(body);
    const version = parseVersion(o);
    const t = await load(ctx, tenderId);
    const to = nextStatus(t.status, action);
    if (!to) throw new TenderError('invalid_state', INVALID_TRANSITION[action]);
    assertVersion(t, version);
    const ts = stamp();
    const { next, details, reason } = build(t, o, ts);
    const item: Tender = { ...t, ...next, status: to, ...touch(ctx, t, ts) };
    await write(ctx, { tender: { item, expectedVersion: version }, audit: audit(ctx, `tender.${action}`, tenderId, { from: t.status, to, ...details }, reason) });
    return { tender: await detailView(ctx, item, 'manager') };
  }

  const INVALID_TRANSITION: Record<TenderAction, string> = {
    collect: 'Yalnızca taslak ihale teklif toplamaya açılabilir',
    publish: 'Yalnızca teklif toplanan ihale sakinlerle paylaşılabilir',
    decide: 'Yalnızca yayınlanmış ihale karara bağlanabilir',
    cancel: 'Karara bağlanmış veya iptal edilmiş ihale iptal edilemez',
  };

  /** Taslak -> teklif toplama. */
  const collect = (ctx: TenderContext, tenderId: string, body: unknown) => transition(ctx, tenderId, 'collect', body, (_t, _o, ts) => ({ next: { collectingAt: ts }, details: {} }));

  /**
   * Teklif toplama -> yayinda (sakinlerle paylasilir). En az bir aktif teklif ve her aktif teklifin
   * belgesi gerekir. Asgari teklif sayisina ulasilmadiysa gerekce zorunludur (sakinler de gorur).
   */
  const publish = (ctx: TenderContext, tenderId: string, body: unknown) =>
    transition(ctx, tenderId, 'publish', body, (t, o, ts) => {
      const r = publishReadiness(t);
      if (!r.activeQuotes) throw new TenderError('unprocessable', 'Yayınlamak için en az bir teklif ekleyin');
      if (r.missingDocuments.length) {
        throw new TenderError('unprocessable', 'Her teklifin belgesi (PDF veya fotoğraf) yüklenmiş olmalı', { missingDocuments: r.missingDocuments });
      }
      let shortfallReason: string | undefined;
      if (r.shortfall) {
        if (o.shortfallReason === undefined || o.shortfallReason === null || o.shortfallReason === '') {
          throw new TenderError('unprocessable', `En az ${t.minQuotes} teklif bekleniyordu (${r.activeQuotes} teklif var); eksik teklifle yayınlamak için gerekçe yazın`, { shortfall: true });
        }
        shortfallReason = reqReason(o, 'shortfallReason', 10, 500);
      }
      return {
        next: { publishedAt: ts, publishedBy: ctx.userId, ...(shortfallReason ? { shortfallReason } : {}) },
        details: { quoteCount: r.activeQuotes, minQuotes: t.minQuotes, ...(shortfallReason ? { shortfall: true } : {}) },
        ...(shortfallReason ? { reason: shortfallReason } : {}),
      };
    });

  /**
   * Yayinda -> karar: secilen aktif teklif + gerekce (en dusuk teklif secilmediyse de gerekce ayni
   * alandir). Genel kurul / anket karari serbest referans olarak baglanabilir. Teklif ozeti saklanir.
   */
  const decide = (ctx: TenderContext, tenderId: string, body: unknown) =>
    transition(ctx, tenderId, 'decide', body, (t, o, ts) => {
      const quoteId = assertId(o.quoteId, 'quoteId');
      const quote = t.quotes.find((q) => q.quoteId === quoteId && q.status === 'active');
      if (!quote) throw new TenderError('not_found', 'Seçilen teklif bulunamadı');
      const reason = reqReason(o, 'reason', 10, 1000);
      const reference = optText(o, 'reference', 200);
      const amounts = normalizeQuote(quote);
      const lowest = compareQuotes(t.quotes).lowestQuoteIds.includes(quoteId);
      return {
        next: { decision: { quoteId, reason, ...(reference ? { reference } : {}), supplierName: quote.supplierName, ...amounts, decidedAt: ts, decidedBy: ctx.userId } },
        details: { quoteId, supplierName: quote.supplierName, totalKurus: amounts.totalKurus, lowest, ...(reference ? { reference } : {}) },
        reason,
      };
    });

  /** Iptal (gerekceli): taslak, teklif toplama veya yayin asamasinda. Kayit silinmez. */
  const cancel = (ctx: TenderContext, tenderId: string, body: unknown) =>
    transition(ctx, tenderId, 'cancel', body, (t, o, ts) => {
      const reason = reqReason(o, 'reason', 10, 500);
      if (!CANCELLABLE_STATUSES.includes(t.status)) throw new TenderError('invalid_state', INVALID_TRANSITION.cancel);
      return { next: { cancelledAt: ts, cancelledBy: ctx.userId, cancelReason: reason, cancelledFrom: t.status }, details: {}, reason };
    });

  // -------------------------------------------------------------------------
  // Teklifler (yonetim; taslak / teklif toplama asamasinda)
  // -------------------------------------------------------------------------

  /**
   * Teklif ekleme (idempotent). Belge verildiyse gecici yukleme ihaleye tasinir (yazimdan once;
   * yazim basarisiz olursa kopya sahipsiz kalir, zararsiz). Ayni anda eklenen teklifler surum
   * cakismasinda guncel ihaleyle yeniden denenir.
   */
  async function addQuote(ctx: TenderContext, tenderId: string, body: unknown) {
    managerOf(ctx);
    const o = asObject(body);
    const key = assertId(o.idempotencyKey, 'idempotencyKey');
    const fields = readQuote(o);
    const upload = readUpload(o);
    const fp = fingerprint({ kind: 'quote', tenderId, ...fields, uploadId: upload?.uploadId });
    const replay = async () => {
      const idem = await replayOf(ctx, key, 'quote', fp);
      if (!idem) return undefined;
      const t = await load(ctx, idem.tenderId);
      if (!t.quotes.some((q) => q.quoteId === idem.targetId)) throw new TenderError('conflict', 'Teklif ekleme sürüyor; tekrar deneyin');
      return { tender: await detailView(ctx, t, 'manager'), quoteId: idem.targetId, replayed: true };
    };
    const prior = await replay();
    if (prior) return prior;

    let t = await load(ctx, tenderId);
    assertEditable(t);
    if (t.quotes.length >= MAX_QUOTES) throw new TenderError('unprocessable', `Bir ihalede en fazla ${MAX_QUOTES} teklif olabilir`);
    const quoteId = `q-${shortId(10)}`;
    const document = upload ? await requireDocuments().promote(ctx.apartmentId, upload, { tenderId, quoteId }) : undefined;
    for (let attempt = 1; ; attempt++) {
      assertEditable(t);
      if (t.quotes.length >= MAX_QUOTES) throw new TenderError('unprocessable', `Bir ihalede en fazla ${MAX_QUOTES} teklif olabilir`);
      const ts = stamp();
      const quote: TenderQuote = { quoteId, ...fields, ...(document ? { document } : {}), status: 'active', createdAt: ts, createdBy: ctx.userId, updatedAt: ts, updatedBy: ctx.userId };
      const next: Tender = { ...t, quotes: [...t.quotes, quote], ...touch(ctx, t, ts) };
      try {
        await repo.write(ctx.apartmentId, {
          tender: { item: next, expectedVersion: t.version },
          idempotency: idempotency(ctx, key, 'quote', tenderId, quoteId, fp, ts),
          audit: audit(ctx, 'tender.quote_add', tenderId, { quoteId, supplierName: fields.supplierName, ...normalizeQuote(fields), vatIncluded: fields.vatIncluded, vatRate: fields.vatRate, document: Boolean(document) }),
        });
        return { tender: await detailView(ctx, next, 'manager'), quoteId, replayed: false };
      } catch (err) {
        if (err instanceof TenderConflictError && err.reason === 'duplicate') {
          const r = await replay();
          if (r) return r;
        }
        if (err instanceof TenderConflictError && err.reason === 'version' && attempt < WRITE_RETRIES) {
          t = await load(ctx, tenderId);
          continue;
        }
        if (err instanceof TenderConflictError) throw new TenderError('conflict', 'İhale başka bir işlemle değişti; sayfayı yenileyin');
        throw err;
      }
    }
  }

  function findActiveQuote(t: Tender, quoteId: string): TenderQuote {
    assertId(quoteId, 'quoteId');
    const q = t.quotes.find((x) => x.quoteId === quoteId);
    if (!q) throw new TenderError('not_found', 'Teklif bulunamadı');
    if (q.status !== 'active') throw new TenderError('invalid_state', 'Geri çekilen teklif değiştirilemez');
    return q;
  }

  /** Teklif duzeltme / belge ekleme-degistirme (ihale surumuyla). */
  async function updateQuote(ctx: TenderContext, tenderId: string, quoteId: string, body: unknown) {
    managerOf(ctx);
    const o = asObject(body);
    const version = parseVersion(o);
    const t = await load(ctx, tenderId);
    assertEditable(t);
    assertVersion(t, version);
    const current = findActiveQuote(t, quoteId);
    const fields = readQuote(o, current);
    const upload = readUpload(o);
    const changed: string[] = QUOTE_FIELDS.filter((k) => fields[k] !== current[k]);
    if (upload) changed.push('document');
    if (!changed.length) return { tender: await detailView(ctx, t, 'manager') };
    const document = upload ? await requireDocuments().promote(ctx.apartmentId, upload, { tenderId, quoteId }) : current.document;
    const ts = stamp();
    const { validUntil: _v, deliveryDays: _d, warrantyMonths: _w, notes: _n, document: _doc, ...base } = current;
    const quote: TenderQuote = { ...base, ...fields, ...(document ? { document } : {}), updatedAt: ts, updatedBy: ctx.userId };
    const next: Tender = { ...t, quotes: t.quotes.map((q) => (q.quoteId === quoteId ? quote : q)), ...touch(ctx, t, ts) };
    await write(ctx, { tender: { item: next, expectedVersion: version }, audit: audit(ctx, 'tender.quote_update', tenderId, { quoteId, fields: changed, ...normalizeQuote(fields) }) });
    return { tender: await detailView(ctx, next, 'manager') };
  }

  /** Teklif geri cekme (gerekceli; silinmez, karsilastirmaya girmez, sakinler gerekceyle gorur). */
  async function withdrawQuote(ctx: TenderContext, tenderId: string, quoteId: string, body: unknown) {
    managerOf(ctx);
    const o = asObject(body);
    const version = parseVersion(o);
    const reason = reqReason(o, 'reason', 3, 300);
    const t = await load(ctx, tenderId);
    assertEditable(t);
    assertVersion(t, version);
    const current = findActiveQuote(t, quoteId);
    const ts = stamp();
    const quote: TenderQuote = { ...current, status: 'withdrawn', withdrawnAt: ts, withdrawnBy: ctx.userId, withdrawReason: reason, updatedAt: ts, updatedBy: ctx.userId };
    const next: Tender = { ...t, quotes: t.quotes.map((q) => (q.quoteId === quoteId ? quote : q)), ...touch(ctx, t, ts) };
    await write(ctx, { tender: { item: next, expectedVersion: version }, audit: audit(ctx, 'tender.quote_withdraw', tenderId, { quoteId, supplierName: current.supplierName }, reason) });
    return { tender: await detailView(ctx, next, 'manager') };
  }

  // -------------------------------------------------------------------------
  // Soru / yorum (yayindaki ihalede: sakin sorar, yonetim yanitlar)
  // -------------------------------------------------------------------------

  async function comment(ctx: TenderContext, tenderId: string, body: unknown) {
    const audience = audienceOf(ctx);
    if (audience === 'observer') throw new TenderError('forbidden', 'Denetçi yorum yazamaz');
    if (audience === 'resident') await residentOf(ctx);
    const o = asObject(body);
    const key = assertId(o.idempotencyKey, 'idempotencyKey');
    const text = reqString(o, 'body', MAX_COMMENT_LENGTH, 3);
    const fp = fingerprint({ kind: 'comment', tenderId, text, by: ctx.userId });
    const t = await loadVisible(ctx, tenderId, audience);
    const result = async () => ({ tender: await detailView(ctx, await load(ctx, tenderId), audience) });
    if (await replayOf(ctx, key, 'comment', fp)) return { ...(await result()), replayed: true };
    if (t.status !== 'published') throw new TenderError('invalid_state', 'Yalnızca yayındaki ihaleye soru yazılabilir');
    const mine = (await repo.listComments(ctx.apartmentId, tenderId)).filter((c) => c.authorId === ctx.userId).length;
    if (mine >= MAX_COMMENTS_PER_USER) throw new TenderError('unprocessable', `Bir ihaleye en fazla ${MAX_COMMENTS_PER_USER} mesaj yazabilirsiniz`);
    const ts = stamp();
    const commentId = `c-${shortId()}`;
    const item: TenderComment = {
      ...tenderKeys.comment(ctx.apartmentId, tenderId, ts, commentId),
      entityType: 'TENDER_COMMENT',
      apartmentId: ctx.apartmentId,
      tenderId,
      commentId,
      body: text,
      authorId: ctx.userId,
      authorRole: ctx.role,
      authorKind: audience === 'resident' ? 'resident' : 'management',
      createdAt: ts,
    };
    try {
      await repo.write(ctx.apartmentId, { comment: { item, requireStatus: 'published' }, idempotency: idempotency(ctx, key, 'comment', tenderId, commentId, fp, ts) });
    } catch (err) {
      if (err instanceof TenderConflictError && err.reason === 'duplicate' && (await replayOf(ctx, key, 'comment', fp))) return { ...(await result()), replayed: true };
      if (err instanceof TenderConflictError && err.reason === 'status') throw new TenderError('invalid_state', 'İhale artık yorumlara açık değil');
      if (err instanceof TenderConflictError) throw new TenderError('conflict', err.message);
      throw err;
    }
    return { ...(await result()), replayed: false };
  }

  return {
    list,
    get,
    create,
    update,
    collect,
    publish,
    decide,
    cancel,
    addQuote,
    updateQuote,
    withdrawQuote,
    quoteDocument,
    comment,
    portalList,
    portalGet,
    portalQuoteDocument,
  };
}

export type TenderService = ReturnType<typeof createTenderService>;
