/**
 * Ihale / teklif toplama: KDV normalizasyonu ve karsilastirma (kurus), durum gecisleri, roller ve
 * kiraci izolasyonu, teklif belgesinin gecici yuklemeden ihaleye tasinmasi, sakin / denetci icin
 * yalnizca yayinlanmis ihalede imzali link, sorular (KVKK: sakin kimligi donmez), API uclari ve
 * DynamoDB yazim bicimi (silme yok).
 */
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthClaims } from '../src/auth/claims.js';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import { pendingUploadKey, tenderQuoteKey } from '../src/modules/documents/keys.js';
import { createDocumentsService } from '../src/modules/documents/service.js';
import { createMemoryDocumentStore } from '../src/modules/documents/store.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import type { Ticket } from '../src/modules/tickets/types.js';
import { allowedActions, compareQuotes, divRound, isShared, nextStatus, normalizeQuote, publishReadiness } from '../src/modules/tenders/model.js';
import { TenderConflictError, createTenderRepository } from '../src/modules/tenders/repository.js';
import { type TenderContext, createTenderService } from '../src/modules/tenders/service.js';
import type { Tender, TenderQuote } from '../src/modules/tenders/types.js';
import { createFakeTenderRepo } from './fakes/tenderRepo.js';

const APT = 'apt-1';
/** Cuma 27.11.2026 10:00 (Istanbul). */
const T0 = '2026-11-27T07:00:00.000Z';

const ctxs = {
  mgr: { apartmentId: APT, userId: 'mgr', role: 'apartment_manager' },
  firm: { apartmentId: APT, userId: 'firm', role: 'management_company' },
  observer: { apartmentId: APT, userId: 'obs', role: 'observer' },
  staff: { apartmentId: APT, userId: 'staff', role: 'building_staff' },
  a: { apartmentId: APT, userId: 'res-a', role: 'resident' },
  b: { apartmentId: APT, userId: 'res-b', role: 'resident' },
  former: { apartmentId: APT, userId: 'res-old', role: 'resident' },
  other: { apartmentId: 'apt-2', userId: 'mgr-2', role: 'apartment_manager' },
} satisfies Record<string, TenderContext>;

const member = (userId: string, unitId: string, extra: Partial<UnitMembership> = {}) =>
  ({ userId, unitId, apartmentId: APT, relation: 'owner', residesInUnit: true, status: 'active', startDate: '2026-01-01', ...extra }) as unknown as UnitMembership;

const quote = (id: string, amountKurus: number, vatIncluded: boolean, vatRate: number, extra: Partial<TenderQuote> = {}): TenderQuote => ({
  quoteId: id,
  supplierName: `Firma ${id}`,
  amountKurus,
  vatIncluded,
  vatRate,
  status: 'active',
  createdAt: T0,
  createdBy: 'mgr',
  updatedAt: T0,
  updatedBy: 'mgr',
  ...extra,
});

function world(opts: { store?: boolean } = {}) {
  const fake = createFakeTenderRepo();
  const memory = createMemoryDocumentStore();
  let n = 0;
  const newId = () => String(++n).padStart(10, '0');
  const documents = createDocumentsService({ store: opts.store === false ? undefined : memory.store, now: () => new Date(T0), newId: () => `up-${String(++n).padStart(6, '0')}` });
  const memberships = [member('res-a', 'u1'), member('res-b', 'u2'), member('res-old', 'u3', { status: 'inactive', endDate: '2026-10-01' })];
  const tickets: Ticket[] = [{ ticketId: 'tk1', apartmentId: APT, number: 'T-000007', title: 'Çatıdan su sızıyor' } as Ticket];
  const service = createTenderService({
    repo: fake.repo,
    documents: { promote: documents.promoteTenderQuote, sign: documents.signTenderDocument },
    tickets: { get: async (apt, id) => tickets.find((t) => t.ticketId === id && t.apartmentId === apt) },
    memberships: { listMemberships: async (apt, userId) => memberships.filter((m) => m.userId === userId && m.apartmentId === apt) },
    now: () => new Date(T0),
    newId,
  });
  let k = 0;
  const create = async (extra: Record<string, unknown> = {}, ctx: TenderContext = ctxs.mgr) =>
    (
      await service.create(ctx, {
        idempotencyKey: `t-key-${++k}`,
        title: 'Dış cephe mantolama',
        description: 'A ve B blok dış cephe mantolama ve boya işi',
        category: 'mantolama',
        deadline: '2026-12-15',
        ...extra,
      })
    ).tender;
  /** Tarayicidan yukleme benzetimi: imzali link alinir, dosya gecici alana konur. */
  const upload = async (contentType = 'application/pdf', size = 2048, apt = APT) => {
    const u = await documents.createInvoiceUpload(apt, { fileName: 'teklif.pdf', contentType, size });
    memory.objects.set(pendingUploadKey(apt, u.uploadId), { body: new Uint8Array(size), contentType });
    return { uploadId: u.uploadId, fileName: 'Teklif — Yılmaz İnşaat.pdf' };
  };
  const addQuote = async (tenderId: string, amountKurus: number, extra: Record<string, unknown> = {}) => {
    const document = extra.document === undefined ? await upload() : extra.document;
    const r = await service.addQuote(ctxs.mgr, tenderId, { idempotencyKey: `q-key-${++k}`, supplierName: `Firma ${k}`, amountKurus, vatIncluded: true, vatRate: 20, ...extra, document: document ?? undefined });
    return r;
  };
  /** Uc teklifle yayinlanmis ihale. */
  const published = async () => {
    const t = await create();
    await service.collect(ctxs.mgr, t.tenderId, { version: 1 });
    await addQuote(t.tenderId, 120_000_00);
    await addQuote(t.tenderId, 100_000_00, { vatIncluded: false, vatRate: 20 });
    const last = await addQuote(t.tenderId, 115_000_00);
    return (await service.publish(ctxs.mgr, t.tenderId, { version: last.tender.version })).tender;
  };
  return { fake, memory, documents, service, create, upload, addQuote, published, memberships };
}

const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));

// ---------------------------------------------------------------------------
// Saf kurallar
// ---------------------------------------------------------------------------

describe('KDV normalizasyonu ve karsilastirma (kurus)', () => {
  it('KDV dahil / haric tutarlar tam sayi aritmetigiyle KDV dahil toplama cevrilir', () => {
    expect(normalizeQuote({ amountKurus: 120_000_00, vatIncluded: true, vatRate: 20 })).toEqual({ netKurus: 100_000_00, vatKurus: 20_000_00, totalKurus: 120_000_00 });
    expect(normalizeQuote({ amountKurus: 100_000_00, vatIncluded: false, vatRate: 20 })).toEqual({ netKurus: 100_000_00, vatKurus: 20_000_00, totalKurus: 120_000_00 });
    // 1.000,01 TL KDV dahil %20: matrah 833,34 (833,341.. yuvarlanir), KDV 166,67; toplam degismez.
    expect(normalizeQuote({ amountKurus: 100_001, vatIncluded: true, vatRate: 20 })).toEqual({ netKurus: 83_334, vatKurus: 16_667, totalKurus: 100_001 });
    // Yarim kurus yukari: 0,25 TL * %10 = 2,5 kurus -> 3.
    expect(normalizeQuote({ amountKurus: 25, vatIncluded: false, vatRate: 10 })).toEqual({ netKurus: 25, vatKurus: 3, totalKurus: 28 });
    expect(normalizeQuote({ amountKurus: 5_000_00, vatIncluded: true, vatRate: 0 })).toEqual({ netKurus: 5_000_00, vatKurus: 0, totalKurus: 5_000_00 });
    // Buyuk tutar: kayan nokta hatasi yok, net + KDV = toplam.
    const big = normalizeQuote({ amountKurus: 99_999_999_999, vatIncluded: true, vatRate: 20 });
    expect(big.netKurus + big.vatKurus).toBe(99_999_999_999);
    expect(big.netKurus).toBe(83_333_333_333);
    expect(divRound(5, 2)).toBe(3);
    expect(divRound(7, 3)).toBe(2);
  });

  it('en dusuk KDV dahil toplam vurgulanir; esitlik, sira, fark (baz puan); geri cekilen disarida', () => {
    const quotes = [
      quote('a', 118_000_00, true, 20), // toplam 118.000
      quote('b', 100_000_00, false, 20), // toplam 120.000
      quote('c', 106_000_00, false, 10), // toplam 116.600 (matrah 106.000)
      quote('d', 90_000_00, false, 20, { status: 'withdrawn' }),
      quote('e', 116_600_00, true, 0), // toplam 116.600 (matrah 116.600)
    ];
    const c = compareQuotes(quotes);
    expect(c.rows.map((r) => [r.quoteId, r.totalKurus, r.rank])).toEqual([
      ['c', 116_600_00, 1],
      ['e', 116_600_00, 1],
      ['a', 118_000_00, 3],
      ['b', 120_000_00, 4],
    ]);
    expect(c.lowestQuoteIds).toEqual(['c', 'e']);
    expect(c.lowestTotalKurus).toBe(116_600_00);
    expect(c.highestTotalKurus).toBe(120_000_00);
    // KDV haric en dusuk matrah farkli olabilir (a: 98.333,33 - toplamda ucuncu).
    expect(c.lowestNetQuoteIds).toEqual(['a']);
    const b = c.rows.find((r) => r.quoteId === 'b');
    expect(b).toMatchObject({ diffKurus: 3_400_00, diffBps: 292, isLowest: false });
    expect(compareQuotes([])).toEqual({ rows: [], lowestQuoteIds: [], lowestNetQuoteIds: [] });
  });

  it('durum gecisleri ve yayin hazirligi', () => {
    expect(nextStatus('draft', 'collect')).toBe('collecting');
    expect(nextStatus('draft', 'publish')).toBeUndefined();
    expect(nextStatus('collecting', 'publish')).toBe('published');
    expect(nextStatus('published', 'decide')).toBe('decided');
    expect(nextStatus('collecting', 'decide')).toBeUndefined();
    expect(nextStatus('decided', 'cancel')).toBeUndefined();
    expect(allowedActions('draft')).toEqual(['collect', 'cancel']);
    expect(allowedActions('published')).toEqual(['decide', 'cancel']);
    expect(allowedActions('decided')).toEqual([]);
    expect(allowedActions('cancelled')).toEqual([]);
    expect(isShared({})).toBe(false);
    expect(isShared({ publishedAt: T0 })).toBe(true);
    const doc = { key: 'k', fileName: 'f.pdf', contentType: 'application/pdf', size: 1 };
    expect(publishReadiness({ minQuotes: 3, quotes: [quote('a', 1, true, 20, { document: doc }), quote('b', 1, true, 20), quote('c', 1, true, 20, { status: 'withdrawn' })] })).toEqual({
      activeQuotes: 2,
      minQuotes: 3,
      missingDocuments: ['b'],
      shortfall: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Ihale tanimi, roller, gecisler
// ---------------------------------------------------------------------------

describe('ihale olusturma ve roller', () => {
  it('yonetici ve yonetim firmasi olusturur (idempotent, denetimli); denetci, sakin ve gorevli olusturamaz', async () => {
    const w = world();
    const body = { idempotencyKey: 'same', title: 'Asansör revizyonu', description: 'İki asansörün motor ve kabin revizyonu', category: 'asansor', deadline: '2026-12-10', ticketId: 'tk1' };
    const a = await w.service.create(ctxs.mgr, body);
    expect(a).toMatchObject({ replayed: false, tender: { status: 'draft', minQuotes: 3, quotes: [], ticket: { ticketId: 'tk1', number: 'T-000007' }, version: 1 } });
    expect(await w.service.create(ctxs.mgr, body)).toMatchObject({ replayed: true, tender: { tenderId: a.tender.tenderId } });
    await expect(w.service.create(ctxs.mgr, { ...body, title: 'Başka iş' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await w.service.create(ctxs.firm, { ...body, idempotencyKey: 'firm-1', ticketId: undefined })).tender.createdBy).toBe('firm');
    expect(w.fake.audits.map((x) => x.action)).toEqual(['tender.create', 'tender.create']);
    expect(w.fake.audits[0]).toMatchObject({ apartmentId: APT, target: { type: 'tender', id: a.tender.tenderId }, details: { category: 'asansor', ticketId: 'tk1' } });
    for (const ctx of [ctxs.observer, ctxs.a, ctxs.staff]) expect(await codeOf(w.service.create(ctx, { ...body, idempotencyKey: 'x' }))).toBe('forbidden');
    expect(await codeOf(w.service.list(ctxs.staff))).toBe('forbidden');
    expect(await codeOf(w.service.list(ctxs.a))).toBe('forbidden');
  });

  it('dogrulama: baslik, aciklama, kategori, gecmis tarih, asgari teklif, talep', async () => {
    const w = world();
    const base = { idempotencyKey: 'v', title: 'Çatı onarımı', description: 'Çatı kiremit değişimi ve izolasyon', category: 'cati', deadline: '2026-12-01' };
    expect(await codeOf(w.service.create(ctxs.mgr, { ...base, title: 'Ç' }))).toMatch(/ValidationError|title/);
    await expect(w.service.create(ctxs.mgr, { ...base, category: 'havuz' })).rejects.toMatchObject({ field: 'category' });
    await expect(w.service.create(ctxs.mgr, { ...base, deadline: '2026-11-26' })).rejects.toMatchObject({ field: 'deadline' });
    await expect(w.service.create(ctxs.mgr, { ...base, deadline: '2026-02-30' })).rejects.toMatchObject({ field: 'deadline' });
    await expect(w.service.create(ctxs.mgr, { ...base, minQuotes: 0 })).rejects.toMatchObject({ field: 'minQuotes' });
    await expect(w.service.create(ctxs.mgr, { ...base, description: 'kısa' })).rejects.toMatchObject({ field: 'description' });
    await expect(w.service.create(ctxs.mgr, { ...base, ticketId: 'yok' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await w.service.create(ctxs.mgr, { ...base, minQuotes: 2 })).tender).toMatchObject({ minQuotes: 2, deadline: '2026-12-01' });
  });

  it('duzenleme yalnizca taslak / toplama asamasinda ve surumlu; talep bagi kaldirilabilir', async () => {
    const w = world();
    const t = await w.create({ ticketId: 'tk1' });
    const u = await w.service.update(ctxs.mgr, t.tenderId, { version: 1, title: 'Mantolama ve boya', ticketId: null, minQuotes: 4 });
    expect(u.tender).toMatchObject({ title: 'Mantolama ve boya', minQuotes: 4, version: 2 });
    expect(u.tender).not.toHaveProperty('ticket');
    expect(w.fake.audits.at(-1)).toMatchObject({ action: 'tender.update', details: { fields: ['title', 'minQuotes', 'ticketId'] } });
    expect(await codeOf(w.service.update(ctxs.mgr, t.tenderId, { version: 1, title: 'Eski sürüm' }))).toBe('conflict');
    // Degisiklik yoksa yazim yok.
    const writes = w.fake.writes.length;
    await w.service.update(ctxs.mgr, t.tenderId, { version: 2, title: 'Mantolama ve boya' });
    expect(w.fake.writes).toHaveLength(writes);
    const p = await w.published();
    expect(await codeOf(w.service.update(ctxs.mgr, p.tenderId, { version: p.version, title: 'Yayından sonra' }))).toBe('invalid_state');
  });

  it('asgari teklif sayisi taslaktan cikinca kilitlenir: toplamada dusurulerek gerekce atlanamaz', async () => {
    const w = world();
    const t = await w.create({ minQuotes: 3 });
    // Taslakta degisebilir.
    expect((await w.service.update(ctxs.mgr, t.tenderId, { version: 1, minQuotes: 4 })).tender.minQuotes).toBe(4);
    const c = await w.service.collect(ctxs.mgr, t.tenderId, { version: 2 });
    const q = await w.addQuote(t.tenderId, 10_000_00);
    await expect(w.service.update(ctxs.mgr, t.tenderId, { version: q.tender.version, minQuotes: 1 })).rejects.toMatchObject({ code: 'invalid_state', details: { field: 'minQuotes' } });
    // Ayni deger veya diger alanlar serbest.
    const u = await w.service.update(ctxs.mgr, t.tenderId, { version: q.tender.version, minQuotes: 4, title: 'Mantolama (A Blok)' });
    expect(u.tender).toMatchObject({ minQuotes: 4, title: 'Mantolama (A Blok)' });
    expect(c.tender.status).toBe('collecting');
    // Yayin hala asgari 4 teklife gore: gerekce zorunlu ve sakin gorur.
    await expect(w.service.publish(ctxs.mgr, t.tenderId, { version: u.tender.version })).rejects.toMatchObject({ code: 'unprocessable', details: { shortfall: true } });
    await w.service.publish(ctxs.mgr, t.tenderId, { version: u.tender.version, shortfallReason: 'Yalnızca bir firma teklif verdi' });
    expect((await w.service.portalGet(ctxs.a, t.tenderId)).tender).toMatchObject({ minQuotes: 4, quoteCount: 1, shortfallReason: 'Yalnızca bir firma teklif verdi' });
  });
});

describe('durum gecisleri', () => {
  it('taslak -> toplama -> yayin -> karar; her gecis surumlu ve denetimli', async () => {
    const w = world();
    const t = await w.create();
    expect(await codeOf(w.service.publish(ctxs.mgr, t.tenderId, { version: 1 }))).toBe('invalid_state');
    expect(await codeOf(w.service.decide(ctxs.mgr, t.tenderId, { version: 1, quoteId: 'x', reason: 'Gerekçe yeterli uzunlukta' }))).toBe('invalid_state');
    const c = await w.service.collect(ctxs.mgr, t.tenderId, { version: 1 });
    expect(c.tender).toMatchObject({ status: 'collecting', version: 2 });
    expect(await codeOf(w.service.collect(ctxs.mgr, t.tenderId, { version: 2 }))).toBe('invalid_state');
    const q1 = await w.addQuote(t.tenderId, 150_000_00);
    const q2 = await w.addQuote(t.tenderId, 100_000_00, { vatIncluded: false, vatRate: 20 });
    const q3 = await w.addQuote(t.tenderId, 118_000_00);
    expect(await codeOf(w.service.publish(ctxs.mgr, t.tenderId, { version: 2 }))).toBe('conflict');
    const p = await w.service.publish(ctxs.mgr, t.tenderId, { version: q3.tender.version });
    expect(p.tender).toMatchObject({ status: 'published', publishedAt: T0, quoteCount: 3, lowestTotalKurus: 118_000_00 });
    expect(p.tender.comparison.lowestQuoteIds).toEqual([q3.quoteId]);
    // Yayindan sonra teklifler donar.
    expect(await codeOf(w.addQuote(t.tenderId, 90_000_00))).toBe('invalid_state');
    expect(await codeOf(w.service.updateQuote(ctxs.mgr, t.tenderId, q1.quoteId, { version: p.tender.version, amountKurus: 1 }))).toBe('invalid_state');
    expect(await codeOf(w.service.withdrawQuote(ctxs.mgr, t.tenderId, q1.quoteId, { version: p.tender.version, reason: 'Firma çekildi' }))).toBe('invalid_state');
    // Karar: gerekce zorunlu, teklif aktif olmali; en dusuk olmayan teklif de secilebilir (gerekceyle).
    await expect(w.service.decide(ctxs.mgr, t.tenderId, { version: p.tender.version, quoteId: q2.quoteId, reason: 'kısa' })).rejects.toMatchObject({ field: 'reason' });
    expect(await codeOf(w.service.decide(ctxs.mgr, t.tenderId, { version: p.tender.version, quoteId: 'q-yok', reason: 'Genel kurul kararı ile seçildi' }))).toBe('not_found');
    const d = await w.service.decide(ctxs.mgr, t.tenderId, { version: p.tender.version, quoteId: q2.quoteId, reason: 'Garanti süresi daha uzun, referansları güçlü', reference: 'Genel kurul 20.12.2026 karar no 3' });
    expect(d.tender).toMatchObject({
      status: 'decided',
      decision: { quoteId: q2.quoteId, supplierName: 'Firma 3', netKurus: 100_000_00, vatKurus: 20_000_00, totalKurus: 120_000_00, reference: 'Genel kurul 20.12.2026 karar no 3', decidedBy: 'mgr' },
    });
    expect(await codeOf(w.service.cancel(ctxs.mgr, t.tenderId, { version: d.tender.version, reason: 'Karar sonrası iptal denemesi' }))).toBe('invalid_state');
    expect(w.fake.audits.map((a) => a.action)).toEqual(['tender.create', 'tender.collect', 'tender.quote_add', 'tender.quote_add', 'tender.quote_add', 'tender.publish', 'tender.decide']);
    expect(w.fake.audits.at(-1)).toMatchObject({ reason: 'Garanti süresi daha uzun, referansları güçlü', details: { from: 'published', to: 'decided', lowest: false, totalKurus: 120_000_00 } });
  });

  it('yayin kurallari: en az bir teklif, her teklifin belgesi, asgari sayi altinda gerekce', async () => {
    const w = world();
    const t = await w.create({ minQuotes: 3 });
    await w.service.collect(ctxs.mgr, t.tenderId, { version: 1 });
    expect(await codeOf(w.service.publish(ctxs.mgr, t.tenderId, { version: 2 }))).toBe('unprocessable');
    const q1 = await w.addQuote(t.tenderId, 50_000_00, { document: null });
    await expect(w.service.publish(ctxs.mgr, t.tenderId, { version: q1.tender.version })).rejects.toMatchObject({ code: 'unprocessable', details: { missingDocuments: [q1.quoteId] } });
    const withDoc = await w.service.updateQuote(ctxs.mgr, t.tenderId, q1.quoteId, { version: q1.tender.version, document: await w.upload('image/jpeg') });
    expect(withDoc.tender.quotes[0]).toMatchObject({ document: { contentType: 'image/jpeg' } });
    expect(w.fake.audits.at(-1)).toMatchObject({ action: 'tender.quote_update', details: { fields: ['document'] } });
    await expect(w.service.publish(ctxs.mgr, t.tenderId, { version: withDoc.tender.version })).rejects.toMatchObject({ code: 'unprocessable', details: { shortfall: true } });
    await expect(w.service.publish(ctxs.mgr, t.tenderId, { version: withDoc.tender.version, shortfallReason: 'az' })).rejects.toMatchObject({ field: 'shortfallReason' });
    const p = await w.service.publish(ctxs.mgr, t.tenderId, { version: withDoc.tender.version, shortfallReason: 'Bölgede bu işi yapan yalnızca bir firma teklif verdi' });
    expect(p.tender).toMatchObject({ status: 'published', shortfallReason: 'Bölgede bu işi yapan yalnızca bir firma teklif verdi' });
    expect(w.fake.audits.at(-1)).toMatchObject({ action: 'tender.publish', reason: 'Bölgede bu işi yapan yalnızca bir firma teklif verdi', details: { shortfall: true, quoteCount: 1, minQuotes: 3 } });
  });

  it('iptal: gerekceli, taslak / toplama / yayinda; kayit silinmez ve sakine (yayinlandiysa) gorunur kalir', async () => {
    const w = world();
    const draft = await w.create();
    await expect(w.service.cancel(ctxs.mgr, draft.tenderId, { version: 1 })).rejects.toMatchObject({ field: 'reason' });
    const c = await w.service.cancel(ctxs.mgr, draft.tenderId, { version: 1, reason: 'Bütçe bu yıl ayrılmadı' });
    expect(c.tender).toMatchObject({ status: 'cancelled', cancelReason: 'Bütçe bu yıl ayrılmadı', cancelledFrom: 'draft' });
    expect(await codeOf(w.service.collect(ctxs.mgr, draft.tenderId, { version: 2 }))).toBe('invalid_state');
    const p = await w.published();
    await w.service.cancel(ctxs.mgr, p.tenderId, { version: p.version, reason: 'Genel kurul işi erteledi' });
    expect((await w.service.portalList(ctxs.a)).items.map((t) => [t.tenderId, t.status])).toEqual([[p.tenderId, 'cancelled']]);
    expect((await w.service.portalGet(ctxs.a, p.tenderId)).tender).toMatchObject({ cancelReason: 'Genel kurul işi erteledi', cancelledFrom: 'published', canComment: false });
    expect(w.fake.store.size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Teklifler ve belgeler
// ---------------------------------------------------------------------------

describe('teklifler ve belge yukleme', () => {
  it('belge gecici yuklemeden ihale on ekine tasinir; tur / boyut S3 nesnesinden; eksik yukleme 422', async () => {
    const w = world();
    const t = await w.create();
    const up = await w.upload('application/pdf', 4096);
    const r = await w.addQuote(t.tenderId, 87_500_00, { document: up, validUntil: '2027-01-31', deliveryDays: 45, warrantyMonths: 24, notes: 'Malzeme dahil' });
    const stored = w.fake.store.get(`APT#${APT}|TENDER#${t.tenderId}`) as unknown as Tender;
    const key = tenderQuoteKey(APT, t.tenderId, r.quoteId, up.uploadId, 'pdf');
    expect(stored.quotes[0]).toMatchObject({ amountKurus: 87_500_00, vatIncluded: true, vatRate: 20, validUntil: '2027-01-31', deliveryDays: 45, warrantyMonths: 24, document: { key, contentType: 'application/pdf', size: 4096, fileName: 'Teklif — Yılmaz İnşaat.pdf' } });
    expect(key).toMatch(new RegExp(`^apartments/${APT}/tenders/${t.tenderId}/quotes/${r.quoteId}/`));
    expect(w.memory.objects.has(key)).toBe(true);
    // Yanit S3 anahtarini sizdirmaz; KDV normalize tutarlar doner.
    expect(r.tender.quotes[0]?.document).toEqual({ fileName: 'Teklif — Yılmaz İnşaat.pdf', contentType: 'application/pdf', size: 4096 });
    expect(r.tender.quotes[0]).toMatchObject({ netKurus: 72_916_67, vatKurus: 14_583_33, totalKurus: 87_500_00 });
    // Yuklenmemis (suresi dolmus) dosya, baska apartmanin yuklemesi ve desteklenmeyen tur.
    expect(await codeOf(w.addQuote(t.tenderId, 1_00, { document: { uploadId: 'yok-123', fileName: 'x.pdf' } }))).toBe('unprocessable');
    const foreign = await w.upload('application/pdf', 10, 'apt-2');
    expect(await codeOf(w.addQuote(t.tenderId, 1_00, { document: foreign }))).toBe('unprocessable');
    const bad = await w.documents.createInvoiceUpload(APT, { fileName: 'a.pdf', contentType: 'application/pdf', size: 10 });
    w.memory.objects.set(pendingUploadKey(APT, bad.uploadId), { body: new Uint8Array(10), contentType: 'text/html' });
    expect(await codeOf(w.addQuote(t.tenderId, 1_00, { document: { uploadId: bad.uploadId, fileName: 'a.pdf' } }))).toBe('unprocessable');
    expect(await codeOf(w.documents.createInvoiceUpload(APT, { fileName: 'b.pdf', contentType: 'application/pdf', size: 11 * 1024 * 1024 }))).toBe('unprocessable');
  });

  it('teklif ekleme idempotent; dogrulama; es zamanli eklemede guncel ihaleyle yeniden denenir; ust sinir', async () => {
    const w = world();
    const t = await w.create();
    const body = { idempotencyKey: 'same-q', supplierName: 'Kaya Yapı', amountKurus: 10_000_00, vatIncluded: false, vatRate: 10 };
    const a = await w.service.addQuote(ctxs.mgr, t.tenderId, body);
    expect(await w.service.addQuote(ctxs.mgr, t.tenderId, body)).toMatchObject({ replayed: true, quoteId: a.quoteId });
    await expect(w.service.addQuote(ctxs.mgr, t.tenderId, { ...body, amountKurus: 9_000_00 })).rejects.toMatchObject({ code: 'conflict' });
    for (const [extra, field] of [
      [{ amountKurus: 0 }, 'amountKurus'],
      [{ amountKurus: 12.5 }, 'amountKurus'],
      [{ vatRate: 101 }, 'vatRate'],
      [{ vatIncluded: 'evet' }, 'vatIncluded'],
      [{ supplierName: 'K' }, 'supplierName'],
      [{ validUntil: '31.01.2027' }, 'validUntil'],
      [{ deliveryDays: 0 }, 'deliveryDays'],
    ] as const) {
      await expect(w.service.addQuote(ctxs.mgr, t.tenderId, { ...body, idempotencyKey: `v-${field}`, ...extra })).rejects.toMatchObject({ field });
    }
    // Araya baska bir teklif girer: surum cakismasi guncel kayitla yeniden denenir, iki teklif de kalir.
    w.fake.beforeNextWrite(async () => {
      await w.service.addQuote(ctxs.firm, t.tenderId, { ...body, idempotencyKey: 'concurrent', supplierName: 'Araya Giren' });
    });
    const b = await w.service.addQuote(ctxs.mgr, t.tenderId, { ...body, idempotencyKey: 'second', supplierName: 'Deniz Mühendislik' });
    expect(b.tender.quotes.map((q) => q.supplierName)).toEqual(['Kaya Yapı', 'Araya Giren', 'Deniz Mühendislik']);
    for (let i = 0; i < 9; i++) await w.service.addQuote(ctxs.mgr, t.tenderId, { ...body, idempotencyKey: `fill-${i}` });
    await expect(w.service.addQuote(ctxs.mgr, t.tenderId, { ...body, idempotencyKey: 'too-many' })).rejects.toMatchObject({ code: 'unprocessable', message: expect.stringContaining('geri çekilen teklifler de sayılır') });
    expect(await codeOf(w.service.addQuote(ctxs.observer, t.tenderId, { ...body, idempotencyKey: 'obs' }))).toBe('forbidden');
  });

  it('teklif duzeltme ve geri cekme: surumlu, gerekceli; geri cekilen karsilastirmaya girmez, silinmez', async () => {
    const w = world();
    const t = await w.create();
    const a = await w.addQuote(t.tenderId, 100_000_00);
    const b = await w.addQuote(t.tenderId, 90_000_00);
    const u = await w.service.updateQuote(ctxs.mgr, t.tenderId, a.quoteId, { version: b.tender.version, amountKurus: 80_000_00, vatIncluded: false, vatRate: 20, notes: '  ' });
    expect(u.tender.quotes.find((q) => q.quoteId === a.quoteId)).toMatchObject({ amountKurus: 80_000_00, vatIncluded: false, totalKurus: 96_000_00 });
    expect(u.tender.comparison.lowestQuoteIds).toEqual([b.quoteId]);
    expect(await codeOf(w.service.withdrawQuote(ctxs.mgr, t.tenderId, b.quoteId, { version: u.tender.version, reason: '' }))).toMatch(/ValidationError|reason/);
    const wd = await w.service.withdrawQuote(ctxs.mgr, t.tenderId, b.quoteId, { version: u.tender.version, reason: 'Firma teklifini geri çekti' });
    expect(wd.tender.quotes).toHaveLength(2);
    expect(wd.tender.quotes.find((q) => q.quoteId === b.quoteId)).toMatchObject({ status: 'withdrawn', withdrawReason: 'Firma teklifini geri çekti' });
    expect(wd.tender.comparison.lowestQuoteIds).toEqual([a.quoteId]);
    expect(wd.tender.quoteCount).toBe(1);
    expect(await codeOf(w.service.updateQuote(ctxs.mgr, t.tenderId, b.quoteId, { version: wd.tender.version, amountKurus: 1 }))).toBe('invalid_state');
    expect(w.fake.audits.at(-1)).toMatchObject({ action: 'tender.quote_withdraw', reason: 'Firma teklifini geri çekti' });
  });

  it('degistirilen belge silinmez: gecmiste tutulur, denetimde eski anahtar, yalnizca yonetim acar', async () => {
    const w = world();
    const t = await w.create();
    const first = await w.upload('application/pdf', 100);
    const a = await w.addQuote(t.tenderId, 10_000_00, { document: first });
    const firstKey = tenderQuoteKey(APT, t.tenderId, a.quoteId, first.uploadId, 'pdf');
    const second = await w.upload('image/png', 200);
    const u = await w.service.updateQuote(ctxs.mgr, t.tenderId, a.quoteId, { version: a.tender.version, document: second });
    const view = u.tender.quotes[0];
    expect(view?.document).toMatchObject({ contentType: 'image/png', size: 200 });
    expect(view?.documentHistory).toEqual([{ fileName: 'Teklif — Yılmaz İnşaat.pdf', contentType: 'application/pdf', size: 100, replacedAt: T0, replacedBy: 'mgr' }]);
    expect(JSON.stringify(u)).not.toContain(firstKey);
    expect(w.memory.objects.has(firstKey)).toBe(true);
    const stored = w.fake.store.get(`APT#${APT}|TENDER#${t.tenderId}`) as unknown as Tender;
    expect(stored.quotes[0]?.documentHistory?.[0]).toMatchObject({ key: firstKey, replacedBy: 'mgr' });
    expect(w.fake.audits.at(-1)).toMatchObject({
      action: 'tender.quote_update',
      details: { fields: ['document'], replacedDocumentKey: firstKey, documentKey: tenderQuoteKey(APT, t.tenderId, a.quoteId, second.uploadId, 'png') },
    });
    // Yonetim eski belgeyi ayni imzali link yoluyla acar; gecersiz / olmayan sira 400 / 404.
    expect((await w.service.quoteDocument(ctxs.mgr, t.tenderId, a.quoteId, { history: '0' })).url).toContain(`${firstKey}?ttl=300`);
    expect((await w.service.quoteDocument(ctxs.mgr, t.tenderId, a.quoteId)).url).toContain('.png?ttl=300');
    expect(await codeOf(w.service.quoteDocument(ctxs.mgr, t.tenderId, a.quoteId, { history: '1' }))).toBe('not_found');
    await expect(w.service.quoteDocument(ctxs.mgr, t.tenderId, a.quoteId, { history: '-1' })).rejects.toMatchObject({ field: 'history' });
    // Yayindan sonra da denetci / sakin onceki belgeyi goremez ve acamaz.
    await w.service.collect(ctxs.mgr, t.tenderId, { version: u.tender.version });
    await w.service.publish(ctxs.mgr, t.tenderId, { version: u.tender.version + 1, shortfallReason: 'Tek firma teklif verdi, diğerleri ret' });
    expect((await w.service.get(ctxs.observer, t.tenderId)).tender.quotes[0]).not.toHaveProperty('documentHistory');
    expect((await w.service.portalGet(ctxs.a, t.tenderId)).tender.quotes[0]).not.toHaveProperty('documentHistory');
    expect(await codeOf(w.service.quoteDocument(ctxs.observer, t.tenderId, a.quoteId, { history: '0' }))).toBe('not_found');
  });

  it('belge deposu yoksa belge eklenemez (503), belgesiz teklif eklenebilir', async () => {
    const w = world({ store: false });
    const t = await w.create();
    expect((await w.addQuote(t.tenderId, 1_000_00, { document: null })).tender.quotes).toHaveLength(1);
    expect(await codeOf(w.addQuote(t.tenderId, 1_000_00, { document: { uploadId: 'up-1', fileName: 'a.pdf' } }))).toBe('unavailable');
  });
});

// ---------------------------------------------------------------------------
// Seffaflik: sakin ve denetci
// ---------------------------------------------------------------------------

describe('seffaflik: sakin ve denetci yalnizca yayinlanmis ihaleyi gorur', () => {
  it('listeler: yonetim hepsini, denetci ve sakin yalnizca paylasilanlari gorur', async () => {
    const w = world();
    const draft = await w.create({ title: 'Boya işi taslağı' });
    const p = await w.published();
    expect((await w.service.list(ctxs.mgr)).items.map((t) => t.tenderId).sort()).toEqual([draft.tenderId, p.tenderId].sort());
    expect((await w.service.list(ctxs.mgr, { status: 'draft' })).items.map((t) => t.tenderId)).toEqual([draft.tenderId]);
    expect(await codeOf(w.service.list(ctxs.mgr, { status: 'hepsi' }))).toMatch(/ValidationError|status/);
    expect((await w.service.list(ctxs.observer)).items.map((t) => t.tenderId)).toEqual([p.tenderId]);
    expect((await w.service.portalList(ctxs.a)).items).toMatchObject([{ tenderId: p.tenderId, quoteCount: 3, lowestTotalKurus: 115_000_00 }]);
    expect(await codeOf(w.service.get(ctxs.observer, draft.tenderId))).toBe('not_found');
    expect(await codeOf(w.service.portalGet(ctxs.a, draft.tenderId))).toBe('not_found');
    // Tasinmis (uyeligi bitmis) sakin goremez.
    expect(await codeOf(w.service.portalList(ctxs.former))).toBe('forbidden');
    expect(await codeOf(w.service.portalList(ctxs.mgr))).toBe('forbidden');
  });

  it('KVKK: ilgili ariza talebi (kimlik / numara / baslik) sakin yanitlarinda yok; yonetim ve denetci gorur', async () => {
    const w = world();
    const t = await w.create({ ticketId: 'tk1' });
    await w.service.collect(ctxs.mgr, t.tenderId, { version: 1 });
    const q = await w.addQuote(t.tenderId, 10_000_00);
    await w.service.publish(ctxs.mgr, t.tenderId, { version: q.tender.version, shortfallReason: 'Tek firma teklif verdi, diğerleri ret' });
    for (const body of [await w.service.portalList(ctxs.a), await w.service.portalGet(ctxs.a, t.tenderId)]) {
      const json = JSON.stringify(body);
      expect(json).not.toContain('"ticket"');
      expect(json).not.toContain('tk1');
      expect(json).not.toContain('T-000007');
      expect(json).not.toContain('Çatıdan su sızıyor');
    }
    expect((await w.service.get(ctxs.observer, t.tenderId)).tender.ticket).toEqual({ ticketId: 'tk1', number: 'T-000007', title: 'Çatıdan su sızıyor' });
    expect((await w.service.list(ctxs.mgr)).items[0]?.ticket?.ticketId).toBe('tk1');
  });

  it('sakin teklifleri yan yana gorur (KDV normalize, en dusuk vurgulu); yonetim alanlari donmez', async () => {
    const w = world();
    const p = await w.published();
    const view = (await w.service.portalGet(ctxs.a, p.tenderId)).tender;
    expect(view.quotes.map((q) => [q.amountKurus, q.vatIncluded, q.totalKurus])).toEqual([
      [120_000_00, true, 120_000_00],
      [100_000_00, false, 120_000_00],
      [115_000_00, true, 115_000_00],
    ]);
    expect(view.comparison.lowestQuoteIds).toEqual([view.quotes[2]?.quoteId]);
    expect(view.comparison.rows.map((r) => r.rank)).toEqual([1, 2, 2]);
    expect(view).not.toHaveProperty('readiness');
    expect(view).not.toHaveProperty('createdBy');
    expect(view.quotes[0]).not.toHaveProperty('createdBy');
    expect(JSON.stringify(view)).not.toContain('apartments/');
  });

  it('imzali belge linki: yonetim her asamada; sakin ve denetci yalnizca yayindan sonra (5 dk)', async () => {
    const w = world();
    const t = await w.create();
    const q = await w.addQuote(t.tenderId, 10_000_00);
    const signed = await w.service.quoteDocument(ctxs.mgr, t.tenderId, q.quoteId);
    expect(signed.url).toMatch(new RegExp(`^memory://get/apartments/${APT}/tenders/${t.tenderId}/quotes/${q.quoteId}/.+\\.pdf\\?ttl=300`));
    expect(signed).toMatchObject({ contentType: 'application/pdf', fileName: 'Teklif — Yılmaz İnşaat.pdf' });
    expect(await codeOf(w.service.portalQuoteDocument(ctxs.a, t.tenderId, q.quoteId))).toBe('not_found');
    expect(await codeOf(w.service.quoteDocument(ctxs.observer, t.tenderId, q.quoteId))).toBe('not_found');
    await w.service.collect(ctxs.mgr, t.tenderId, { version: q.tender.version });
    await w.service.publish(ctxs.mgr, t.tenderId, { version: q.tender.version + 1, shortfallReason: 'Tek firma teklif verebildi, diğerleri ret' });
    expect((await w.service.portalQuoteDocument(ctxs.a, t.tenderId, q.quoteId)).url).toContain('ttl=300');
    expect((await w.service.quoteDocument(ctxs.observer, t.tenderId, q.quoteId)).url).toContain('ttl=300');
    expect(await codeOf(w.service.portalQuoteDocument(ctxs.a, t.tenderId, 'q-yok'))).toBe('not_found');
    expect(await codeOf(w.service.portalQuoteDocument(ctxs.former, t.tenderId, q.quoteId))).toBe('forbidden');
    // Belge kaydi baska on eke isaret ediyorsa imzalanmaz.
    await expect(w.documents.signTenderDocument(APT, { key: 'apartments/apt-2/tenders/x/a.pdf', fileName: 'a.pdf', contentType: 'application/pdf' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.documents.signTenderDocument(APT, { key: `apartments/${APT}/invoices/2026/11/e.pdf`, fileName: 'a.pdf', contentType: 'application/pdf' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('kiraci izolasyonu: baska apartmanin yoneticisi ihaleyi goremez, degistiremez, belgesini acamaz', async () => {
    const w = world();
    const p = await w.published();
    expect((await w.service.list(ctxs.other)).items).toEqual([]);
    expect(await codeOf(w.service.get(ctxs.other, p.tenderId))).toBe('not_found');
    expect(await codeOf(w.service.cancel(ctxs.other, p.tenderId, { version: p.version, reason: 'Başka sitenin iptali' }))).toBe('not_found');
    expect(await codeOf(w.service.quoteDocument(ctxs.other, p.tenderId, p.quotes[0]?.quoteId ?? ''))).toBe('not_found');
    expect(await codeOf(w.service.portalGet({ ...ctxs.a, apartmentId: 'apt-2' }, p.tenderId))).toBe('forbidden');
  });
});

describe('sorular ve yanitlar', () => {
  it('sakin yayindaki ihaleye soru yazar; yonetim yanitlar; sakin kimlikleri sakine donmez; denetci yazamaz', async () => {
    const w = world();
    const p = await w.published();
    const r = await w.service.comment(ctxs.a, p.tenderId, { idempotencyKey: 'c1', body: 'Teklifler iskele dahil mi?' });
    expect(r).toMatchObject({ replayed: false, tender: { comments: [{ body: 'Teklifler iskele dahil mi?', authorKind: 'resident', mine: true }] } });
    expect(await w.service.comment(ctxs.a, p.tenderId, { idempotencyKey: 'c1', body: 'Teklifler iskele dahil mi?' })).toMatchObject({ replayed: true });
    await w.service.comment(ctxs.mgr, p.tenderId, { idempotencyKey: 'c2', body: 'Evet, üç teklifte de iskele dahil.' });
    const forB = (await w.service.portalGet(ctxs.b, p.tenderId)).tender.comments;
    expect(forB.map((c) => [c.authorKind, c.mine])).toEqual([
      ['resident', false],
      ['management', false],
    ]);
    expect(forB[0]).not.toHaveProperty('authorId');
    // Denetci de sakin kimligini gormez (kisisel veri maskesi); yalnizca yonetim.
    const forObserver = (await w.service.get(ctxs.observer, p.tenderId)).tender.comments;
    expect(forObserver.map((c) => c.authorKind)).toEqual(['resident', 'management']);
    for (const c of forObserver) {
      expect(c).not.toHaveProperty('authorId');
      expect(c).not.toHaveProperty('authorRole');
    }
    expect((await w.service.get(ctxs.mgr, p.tenderId)).tender.comments[0]).toMatchObject({ authorId: 'res-a', authorRole: 'resident' });
    // Yonetim yaniti denetime yazilir (kimlik + uzunluk, metin yok); sakin sorusu yazilmaz.
    const commentAudits = w.fake.audits.filter((a) => a.action === 'tender.comment');
    expect(commentAudits).toHaveLength(1);
    expect(commentAudits[0]).toMatchObject({ target: { type: 'tender', id: p.tenderId }, details: { length: 'Evet, üç teklifte de iskele dahil.'.length } });
    expect(commentAudits[0]?.details?.commentId).toMatch(/^c-/);
    expect(JSON.stringify(commentAudits[0])).not.toContain('iskele');
    expect(await codeOf(w.service.comment(ctxs.observer, p.tenderId, { idempotencyKey: 'c3', body: 'Denetçi notu' }))).toBe('forbidden');
    await expect(w.service.comment(ctxs.b, p.tenderId, { idempotencyKey: 'c4', body: 'ab' })).rejects.toMatchObject({ field: 'body' });
    expect(await codeOf(w.service.comment(ctxs.former, p.tenderId, { idempotencyKey: 'c5', body: 'Eski sakin sorusu' }))).toBe('forbidden');
    // Soru yalnizca yayinda; karardan sonra kapanir; yayinlanmamis ihale sakine yok.
    const d = await w.service.decide(ctxs.mgr, p.tenderId, { version: p.version, quoteId: p.comparison.lowestQuoteIds[0] ?? '', reason: 'En düşük teklif ve uygun şartlar' });
    expect(d.tender.canComment).toBe(false);
    expect(await codeOf(w.service.comment(ctxs.a, p.tenderId, { idempotencyKey: 'c6', body: 'Karar sonrası soru' }))).toBe('invalid_state');
    const draft = await w.create();
    expect(await codeOf(w.service.comment(ctxs.a, draft.tenderId, { idempotencyKey: 'c7', body: 'Taslağa soru' }))).toBe('not_found');
    expect(await codeOf(w.service.comment(ctxs.mgr, draft.tenderId, { idempotencyKey: 'c8', body: 'Taslağa not' }))).toBe('invalid_state');
  });

  it('yorum yazimi ihalenin yayinda oldugunu ayni islemde kontrol eder; kullanici basina sinir', async () => {
    const w = world();
    const p = await w.published();
    w.fake.beforeNextWrite(async () => {
      await w.service.decide(ctxs.mgr, p.tenderId, { version: p.version, quoteId: p.quotes[0]?.quoteId ?? '', reason: 'Araya giren karar yazımı' });
    });
    expect(await codeOf(w.service.comment(ctxs.a, p.tenderId, { idempotencyKey: 'race', body: 'Aynı anda soru' }))).toBe('invalid_state');
    const q = await w.published();
    for (let i = 0; i < 20; i++) await w.service.comment(ctxs.b, q.tenderId, { idempotencyKey: `m-${i}`, body: `Soru numarası ${i}` });
    expect(await codeOf(w.service.comment(ctxs.b, q.tenderId, { idempotencyKey: 'm-20', body: 'Bir soru daha' }))).toBe('unprocessable');
    // Sinir yalnizca sakine: yonetim 20'den fazla yanit yazabilir, diger sakin etkilenmez.
    for (let i = 0; i < 25; i++) await w.service.comment(ctxs.mgr, q.tenderId, { idempotencyKey: `r-${i}`, body: `Yanıt numarası ${i}` });
    expect((await w.service.comment(ctxs.a, q.tenderId, { idempotencyKey: 'a-1', body: 'Başka bir sakin sorusu' })).replayed).toBe(false);
    expect((await w.service.get(ctxs.mgr, q.tenderId)).tender.comments).toHaveLength(46);
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

describe('API uclari', () => {
  function api() {
    const w = world();
    const app = createApp({
      version: 'test',
      tenderService: w.service,
      authenticate: (c) => {
        const raw = c.req.header('x-test-claims');
        return raw ? (JSON.parse(raw) as AuthClaims) : null;
      },
    });
    const call = async (method: string, path: string, ctx: TenderContext | { userId: string; role: string; apartmentId?: string }, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: { 'x-test-claims': JSON.stringify(ctx), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, cache: res.headers.get('cache-control'), json: (await res.json()) as Record<string, any> };
    };
    return { w, call };
  }
  const body = { idempotencyKey: 'api-t-1', title: 'Boya badana', description: 'Merdiven boşluğu boya badana işi', category: 'boya', deadline: '2026-12-20', minQuotes: 1 };

  it('roller: yonetim yazar, denetci okur, sakin / gorevli yonetim uclarina giremez; 201/200; no-store', async () => {
    const { call } = api();
    expect((await call('POST', '/api/tenders', ctxs.observer, body)).status).toBe(403);
    const created = await call('POST', '/api/tenders', ctxs.mgr, body);
    expect(created).toMatchObject({ status: 201, cache: 'no-store', json: { tender: { status: 'draft', title: 'Boya badana' } } });
    expect((await call('POST', '/api/tenders', ctxs.mgr, body)).status).toBe(200);
    const id = created.json.tender.tenderId as string;
    for (const ctx of [ctxs.a, ctxs.staff]) expect((await call('GET', '/api/tenders', ctx)).status).toBe(403);
    expect((await call('GET', '/api/tenders', { userId: 'mgr', role: 'apartment_manager' })).status).toBe(403);
    expect((await call('GET', '/api/tenders', ctxs.observer)).json.items).toEqual([]);
    expect((await call('GET', `/api/tenders/${id}`, ctxs.observer)).status).toBe(404);
    expect((await call('POST', `/api/tenders/${id}/collect`, ctxs.observer, { version: 1 })).status).toBe(403);
    expect((await call('POST', `/api/tenders/${id}/publish`, ctxs.mgr, { version: 1 })).json).toMatchObject({ error: 'invalid_state' });
    expect((await call('POST', `/api/tenders/${id}/collect`, ctxs.mgr, { version: 1 })).json.tender.status).toBe('collecting');
    const q = await call('POST', `/api/tenders/${id}/quotes`, ctxs.mgr, { idempotencyKey: 'api-q-1', supplierName: 'Renk Boya', amountKurus: 25_000_00, vatIncluded: false, vatRate: 20 });
    expect(q).toMatchObject({ status: 201, json: { tender: { quotes: [{ totalKurus: 30_000_00 }] } } });
    const missing = await call('POST', `/api/tenders/${id}/publish`, ctxs.mgr, { version: 3 });
    expect(missing).toMatchObject({ status: 422, json: { error: 'unprocessable', missingDocuments: [q.json.quoteId] } });
    expect((await call('PATCH', `/api/tenders/${id}`, ctxs.mgr, { version: 1, title: 'Eski' })).status).toBe(409);
    expect((await call('POST', '/api/tenders', ctxs.mgr, { ...body, idempotencyKey: 'api-t-2', category: 'yok' })).json).toMatchObject({ error: 'validation_error', field: 'category' });
  });

  it('sakin akisi: liste, ayrinti, imzali belge, soru; yonetim portal uclarina giremez', async () => {
    const { w, call } = api();
    const p = await w.published();
    expect((await call('GET', '/api/portal/tenders', ctxs.mgr)).status).toBe(403);
    expect((await call('GET', '/api/portal/tenders', ctxs.a)).json.items).toHaveLength(1);
    const detail = await call('GET', `/api/portal/tenders/${p.tenderId}`, ctxs.a);
    expect(detail).toMatchObject({ status: 200, cache: 'no-store', json: { tender: { status: 'published', canComment: true } } });
    const doc = await call('GET', `/api/portal/tenders/${p.tenderId}/quotes/${p.quotes[0]?.quoteId}/document`, ctxs.a);
    expect(doc).toMatchObject({ status: 200, cache: 'no-store', json: { contentType: 'application/pdf' } });
    expect(doc.json.url).toContain('ttl=300');
    const c = await call('POST', `/api/portal/tenders/${p.tenderId}/comments`, ctxs.a, { idempotencyKey: 'api-c-1', body: 'Ödeme takvimi nasıl olacak?' });
    expect(c.status).toBe(201);
    expect((await call('POST', `/api/tenders/${p.tenderId}/comments`, ctxs.observer, { idempotencyKey: 'api-c-2', body: 'Denetçi' })).status).toBe(403);
    expect((await call('POST', `/api/tenders/${p.tenderId}/comments`, ctxs.mgr, { idempotencyKey: 'api-c-3', body: 'Üç taksit halinde.' })).status).toBe(201);
    expect((await call('GET', `/api/portal/tenders/nope`, ctxs.a)).status).toBe(404);
    expect((await call('GET', `/api/portal/tenders/${p.tenderId}`, ctxs.former)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DynamoDB deposu
// ---------------------------------------------------------------------------

describe('ihale deposu (DynamoDB)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-north-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });
  const pk = `APT#${APT}`;
  const tender = { PK: pk, SK: 'TENDER#t1', entityType: 'TENDER', apartmentId: APT, tenderId: 't1', status: 'published', version: 2 } as unknown as Tender;

  it('yeni ihale + idempotency kosullu Put; guncelleme surum kosullu; Delete yok; kosul hatasi nedenine gore', async () => {
    const repo = createTenderRepository();
    ddb.on(TransactWriteCommand).resolves({});
    await repo.write(APT, {
      tender: { item: { ...tender, version: 1 } as Tender, expectedVersion: 0 },
      idempotency: { PK: pk, SK: 'TIDEM#k1', entityType: 'TENDER_IDEMPOTENCY', apartmentId: APT, kind: 'tender', tenderId: 't1', targetId: 't1', fingerprint: 'f', createdAt: T0 },
    });
    await repo.write(APT, { tender: { item: { ...tender, version: 3 } as Tender, expectedVersion: 2 } });
    const [first, second] = ddb.commandCalls(TransactWriteCommand).map((c) => c.args[0].input.TransactItems!);
    expect(first?.map((i) => Object.keys(i)[0])).toEqual(['Put', 'Put']);
    expect(first?.[0]?.Put).toMatchObject({ ConditionExpression: 'attribute_not_exists(PK)', Item: { SK: 'TIDEM#k1' } });
    expect(first?.[1]?.Put).toMatchObject({ ConditionExpression: 'attribute_not_exists(PK)', Item: { SK: 'TENDER#t1' } });
    expect(second?.[0]?.Put).toMatchObject({ ConditionExpression: 'attribute_exists(PK) AND #version = :expected', ExpressionAttributeValues: { ':expected': 2 } });
    expect(JSON.stringify([first, second])).not.toContain('Delete');

    ddb.on(TransactWriteCommand).callsFake((input: { TransactItems: unknown[] }) => {
      throw new TransactionCanceledException({ message: 'iptal', $metadata: {}, CancellationReasons: input.TransactItems.map((_, i) => ({ Code: i === 0 ? 'ConditionalCheckFailed' : 'None' })) });
    });
    await expect(repo.write(APT, { tender: { item: { ...tender, version: 3 } as Tender, expectedVersion: 2 } })).rejects.toMatchObject({ reason: 'version' });
    await expect(repo.write('apt-2', { tender: { item: tender, expectedVersion: 1 } })).rejects.toThrow(/Kiraci/);
  });

  it('yorum: ihalenin durumu ayni islemde kontrol edilir (ConditionCheck), yorum yalnizca eklenir', async () => {
    const repo = createTenderRepository();
    ddb.on(TransactWriteCommand).resolvesOnce({});
    const comment = { PK: pk, SK: `TCMT#t1#${T0}#c1`, entityType: 'TENDER_COMMENT' as const, apartmentId: APT, tenderId: 't1', commentId: 'c1', body: 'Soru', authorId: 'res-a', authorRole: 'resident', authorKind: 'resident' as const, createdAt: T0 };
    await repo.write(APT, { comment: { item: comment, requireStatus: 'published' } });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items[0]?.ConditionCheck).toMatchObject({ Key: { PK: pk, SK: 'TENDER#t1' }, ConditionExpression: 'attribute_exists(PK) AND #status = :status', ExpressionAttributeValues: { ':status': 'published' } });
    expect(items[1]?.Put).toMatchObject({ ConditionExpression: 'attribute_not_exists(PK)', Item: { SK: `TCMT#t1#${T0}#c1` } });
    ddb.on(TransactWriteCommand).callsFake(() => {
      throw new TransactionCanceledException({ message: 'iptal', $metadata: {}, CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }] });
    });
    const err = await repo.write(APT, { comment: { item: comment, requireStatus: 'published' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenderConflictError);
    expect(err).toMatchObject({ reason: 'status' });
  });
});
