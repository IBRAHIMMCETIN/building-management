import { CopyObjectCommand, HeadObjectCommand, NotFound, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { PDFDocument } from 'pdf-lib';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthClaims } from '../src/auth/claims.js';
import type { Block, Site, Unit } from '../src/modules/core/types.js';
import { toKurus } from '../src/modules/core/types.js';
import { amountInWordsTR, integerInWordsTR } from '../src/modules/documents/amountWords.js';
import { DocumentError } from '../src/modules/documents/errors.js';
import { RECEIPT_TEMPLATE_VERSION, contentDisposition, invoiceKey, pendingUploadKey, receiptKey, safeFileName } from '../src/modules/documents/keys.js';
import { renderReceiptPdf } from '../src/modules/documents/receiptPdf.js';
import { createDocumentsService } from '../src/modules/documents/service.js';
import { createMemoryDocumentStore, createS3DocumentStore } from '../src/modules/documents/store.js';
import type { Expense, Payment, Transaction } from '../src/modules/finance/types.js';

const APT = 'apt-1';
const NOW = new Date('2026-11-11T10:00:00.000Z');
const audit = { createdAt: NOW.toISOString(), createdBy: 'seed', updatedAt: NOW.toISOString(), updatedBy: 'seed', version: 1 };

// ---------------------------------------------------------------------------
// Yaziyla tutar
// ---------------------------------------------------------------------------

describe('amountInWordsTR', () => {
  it.each([
    [0, 'Sıfır Türk lirası'],
    [100, 'Bir Türk lirası'],
    [50, 'Elli kuruş'],
    [150050, 'Bin beş yüz Türk lirası elli kuruş'],
    [100100, 'Bin bir Türk lirası'],
    [211100, 'İki bin yüz on bir Türk lirası'],
    [10_000_000, 'Yüz bin Türk lirası'],
    [100_000_000, 'Bir milyon Türk lirası'],
    [123456789, 'Bir milyon iki yüz otuz dört bin beş yüz altmış yedi Türk lirası seksen dokuz kuruş'],
    [99_999_999_999, 'Dokuz yüz doksan dokuz milyon dokuz yüz doksan dokuz bin dokuz yüz doksan dokuz Türk lirası doksan dokuz kuruş'],
  ])('%i kurus -> %s', (kurus, text) => {
    expect(amountInWordsTR(kurus)).toBe(text);
  });

  it('gecersiz girdiyi reddeder; "bir milyar" denir', () => {
    expect(() => amountInWordsTR(-1)).toThrow();
    expect(() => amountInWordsTR(1.5)).toThrow();
    expect(integerInWordsTR(1_000_000_000)).toBe('bir milyar');
  });
});

describe('S3 anahtarlari ve dosya adlari', () => {
  it('proje duzenine uyar: apartments/{apt}/..., gecici yuklemeler tmp/ altinda', () => {
    expect(receiptKey(APT, '2026-11-05', 'p1', false)).toBe('apartments/apt-1/receipts/2026/11/p1.v2.pdf');
    expect(receiptKey(APT, '2026-11-05', 'p1', true)).toBe('apartments/apt-1/receipts/2026/11/p1-iptal.v2.pdf');
    expect(invoiceKey(APT, '2026-01-31', 'e1', 'pdf')).toBe('apartments/apt-1/invoices/2026/01/e1.pdf');
    expect(pendingUploadKey(APT, 'u1')).toBe('tmp/apt-1/invoice-uploads/u1');
  });

  it('dosya adi yol/tirnak/kontrol karakterinden arindirilir, Turkce korunur', () => {
    expect(safeFileName('../../etc/"Elektrik Faturası".pdf')).toBe('Elektrik Faturası.pdf');
    expect(safeFileName('C:\\Users\\a\\şubat\tfatura.jpg')).toBe('şubat fatura.jpg');
    expect(safeFileName('///', 'fatura')).toBe('fatura');
    expect(safeFileName('x'.repeat(300))).toHaveLength(120);
  });

  it('Content-Disposition: ASCII yedek + UTF-8 ad', () => {
    expect(contentDisposition('Makbuz-MKB-000001.pdf')).toBe(`inline; filename="Makbuz-MKB-000001.pdf"; filename*=UTF-8''Makbuz-MKB-000001.pdf`);
    expect(contentDisposition('Şubat faturası.pdf', 'attachment')).toBe(
      `attachment; filename="Subat faturas.pdf"; filename*=UTF-8''%C5%9Eubat%20faturas%C4%B1.pdf`,
    );
  });
});

const receiptData = {
  receiptNumber: 'MKB-000012',
  apartmentName: 'Lale Apartmanı',
  apartmentAddress: 'Moda Cd. 1, Kadıköy / İstanbul',
  unitLabel: 'A Blok · Daire 5',
  partyLabel: 'Oturan (Kiracı/Sakin)',
  payerName: 'Ayşe Yılmaz',
  methodLabel: 'Nakit',
  paidAt: '2026-11-05',
  amount: 150050,
  description: 'Aidat ve ortak gider tahsilatı',
  issuedAt: '2026-11-05T09:30:00.000Z',
};

describe('makbuz PDF', () => {
  it('sablon surumu anahtarda: sablon degisince eski onbellek kullanilmaz', () => {
    expect(RECEIPT_TEMPLATE_VERSION).toBe(2);
    expect(receiptKey(APT, '2026-11-05', 'p1', false)).toMatch(/\.v2\.pdf$/);
  });

  it('Turkce karakterli tek sayfalik PDF uretir, font gomulur, ust veri makbuz no icerir', async () => {
    const bytes = await renderReceiptPdf(receiptData);
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe('Tahsilat Makbuzu MKB-000012');
    expect(doc.getCreationDate()?.toISOString()).toBe('2026-11-05T09:30:00.000Z');
    expect(Buffer.from(bytes).includes('/FontFile2')).toBe(true);
    // Onceden alt kumeye indirilmis fontlar: tam Noto Sans (~600 KB x 2) gomulmez.
    expect(bytes.byteLength).toBeLessThan(80_000);
  });

  it('ayni girdi ayni dosyayi uretir (onbellek guvenli); iptal damgasi icerigi degistirir', async () => {
    const a = await renderReceiptPdf(receiptData);
    const b = await renderReceiptPdf(receiptData);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const reversed = await renderReceiptPdf({ ...receiptData, reversed: true });
    expect(Buffer.from(reversed).equals(Buffer.from(a))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

const site = { PK: 'APT#apt-1', SK: 'SITE', entityType: 'SITE', siteId: APT, tenantId: 't', name: 'Lale Apartmanı', type: 'apartment', address: { line1: 'Moda Cd. 1', district: 'Kadıköy', city: 'İstanbul' }, fiscalYearStartMonth: 1, settings: {}, status: 'active', ...audit } as unknown as Site;
const unit = { unitId: 'u1', siteId: APT, blockId: 'b1', number: '5', status: 'active' } as Unit;
const block = { blockId: 'b1', name: 'A Blok' } as Block;

function payment(over: Partial<Payment> = {}): Payment {
  return {
    PK: 'APT#apt-1', SK: 'PAY#p1', entityType: 'PAYMENT', paymentId: 'p1', siteId: APT, unitId: 'u1', liableParty: 'occupant',
    method: 'cash', amount: toKurus(150050), depositAccountId: 'cash', receiptNumber: 'MKB-000001', transactionId: 'tx-pay',
    paidAt: '2026-11-05', payerName: 'Ayşe', createdAt: '2026-11-05T09:30:00.000Z', createdBy: 'mgr', ...over,
  };
}

function tx(id: string, over: Partial<Transaction>): Transaction {
  return {
    PK: 'APT#apt-1', SK: `TX#${id}`, entityType: 'TRANSACTION', transactionId: id, siteId: APT, kind: 'payment', date: '2026-11-05', description: 'x',
    lines: [{ accountId: 'recv-u1-occupant', side: 'credit', amount: toKurus(150050), unitId: 'u1', liableParty: 'occupant' }],
    totalAmount: toKurus(150050), createdAt: NOW.toISOString(), createdBy: 'm', ...over,
  };
}

function setup(options: { store?: boolean } = {}) {
  const mem = createMemoryDocumentStore();
  const puts: string[] = [];
  const store =
    options.store === false
      ? undefined
      : {
          ...mem.store,
          put: async (k: string, b: Uint8Array, ct: string) => {
            puts.push(k);
            await mem.store.put(k, b, ct);
          },
        };
  const txs = new Map<string, Transaction>([
    ['tx-pay', tx('tx-pay', {})],
    ['tx-due', tx('tx-due', { kind: 'dues_charge' })],
    ['tx-exp', tx('tx-exp', { kind: 'expense', invoice: { expenseId: 'e1', fileName: 'Elektrik Kasım.pdf' } })],
    ['tx-exp-none', tx('tx-exp-none', { kind: 'expense' })],
    ['tx-other-apt', tx('tx-other-apt', { siteId: 'apt-2' })],
  ]);
  const payments = new Map<string, Payment>([['p1', payment()]]);
  const expenses = new Map<string, Expense>([
    ['e1', { expenseId: 'e1', siteId: APT, invoice: { key: 'apartments/apt-1/invoices/2026/11/e1.pdf', fileName: 'Elektrik Kasım.pdf', contentType: 'application/pdf', size: 1000 } } as Expense],
  ]);
  const reversed = new Set<string>();
  let myReceipts: string[] = ['p1'];
  let n = 0;
  const service = createDocumentsService({
    store,
    finance: {
      // Depo sahte; apartman kontrolunu servisin kendisinin yaptigini gormek icin baska
      // apartmanin islemi de doner.
      getTransaction: async (_a, id) => txs.get(id),
      getPayment: async (a, id) => (a === APT ? payments.get(id) : undefined),
      getExpense: async (a, id) => (a === APT ? expenses.get(id) : undefined),
      getIdempotency: async (_a, id) => (reversed.has(id) ? { transactionId: 'rev', fingerprint: 'x' } : undefined),
    },
    payments: { listUnitPayments: async (a, u) => [...payments.values()].filter((p) => p.siteId === a && p.unitId === u) },
    core: { getSite: async () => site, getUnit: async () => unit, getBlock: async () => block },
    portal: { getMyReceipts: async () => ({ unitId: 'u1', currency: 'TRY' as const, items: myReceipts.map((paymentId) => ({ paymentId }) as never) }) },
    now: () => NOW,
    newId: () => `id-${++n}`,
  });
  return { service, mem, puts, reversed, setMine: (ids: string[]) => (myReceipts = ids) };
}

describe('documents servisi - makbuz', () => {
  it('ilk istekte PDF uretip S3e yazar, sonraki isteklerde onbellegi kullanir; 5 dk imzali link', async () => {
    const { service, mem, puts } = setup();
    const first = await service.receiptForTransaction(APT, 'tx-pay');
    expect(first).toMatchObject({ fileName: 'Makbuz-MKB-000001.pdf', contentType: 'application/pdf', status: 'valid', expiresAt: '2026-11-11T10:05:00.000Z' });
    expect(first.url).toContain('apartments/apt-1/receipts/2026/11/p1.v2.pdf');
    expect(first.url).toContain('ttl=300');
    expect(puts).toEqual(['apartments/apt-1/receipts/2026/11/p1.v2.pdf']);
    expect(mem.objects.get('apartments/apt-1/receipts/2026/11/p1.v2.pdf')?.contentType).toBe('application/pdf');

    await service.receiptForTransaction(APT, 'tx-pay');
    expect(puts).toHaveLength(1);
  });

  it('iptal edilen tahsilat icin ayri, damgali makbuz uretilir (onbellekteki gecerli makbuz verilmez)', async () => {
    const { service, puts, reversed } = setup();
    await service.receiptForTransaction(APT, 'tx-pay');
    reversed.add('REV_tx-pay');
    const r = await service.receiptForTransaction(APT, 'tx-pay');
    expect(r).toMatchObject({ status: 'reversed', fileName: 'Makbuz-MKB-000001-IPTAL.pdf' });
    expect(puts).toEqual(['apartments/apt-1/receipts/2026/11/p1.v2.pdf', 'apartments/apt-1/receipts/2026/11/p1-iptal.v2.pdf']);
  });

  it('tahsilat olmayan, olmayan veya baska apartmanin islemi 404', async () => {
    const { service } = setup();
    for (const id of ['tx-due', 'yok', 'tx-other-apt']) {
      await expect(service.receiptForTransaction(APT, id)).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
    }
    await expect(service.receiptForTransaction(APT, '../x')).rejects.toMatchObject({ field: 'transactionId' });
  });

  it('sakin yalnizca kendi makbuz listesindeki makbuzu indirebilir', async () => {
    const { service, setMine } = setup();
    const ctx = { apartmentId: APT, userId: 'tenant-1', role: 'resident' as const };
    expect((await service.residentReceipt(ctx, 'p1')).fileName).toBe('Makbuz-MKB-000001.pdf');
    setMine([]);
    await expect(service.residentReceipt(ctx, 'p1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('depo yapilandirilmamissa 503', async () => {
    const { service } = setup({ store: false });
    await expect(service.receiptForTransaction(APT, 'tx-pay')).rejects.toMatchObject({ code: 'unavailable', httpStatus: 503 });
  });
});

describe('documents servisi - gider faturasi', () => {
  it('yukleme linki: tur ve boyut dogrulanir; dosya gecici alana gider', async () => {
    const { service } = setup();
    const ok = await service.createInvoiceUpload(APT, { fileName: 'C:\\fatura.pdf', contentType: 'application/pdf', size: 2048 });
    expect(ok).toMatchObject({ uploadId: 'id-1', fileName: 'fatura.pdf', method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, maxBytes: 10 * 1024 * 1024 });
    expect(ok.uploadUrl).toContain('tmp/apt-1/invoice-uploads/id-1');
    expect(ok.uploadUrl).toContain('ct=application%2Fpdf');

    await expect(service.createInvoiceUpload(APT, { fileName: 'a.exe', contentType: 'application/x-msdownload', size: 1 })).rejects.toBeInstanceOf(DocumentError);
    await expect(service.createInvoiceUpload(APT, { fileName: 'a.pdf', contentType: 'application/pdf', size: 10 * 1024 * 1024 + 1 })).rejects.toMatchObject({ code: 'unprocessable' });
  });

  it('gider kaydinda gecici dosya dogrulanip kalici fatura anahtarina kopyalanir', async () => {
    const { service, mem } = setup();
    const target = { expenseId: 'e9', date: '2026-11-10' };
    await expect(service.promoteInvoice(APT, { uploadId: 'up1', fileName: 'x.pdf' }, target)).rejects.toMatchObject({ code: 'unprocessable' });

    mem.objects.set('tmp/apt-1/invoice-uploads/up1', { body: new Uint8Array(500), contentType: 'image/jpeg' });
    const a = await service.promoteInvoice(APT, { uploadId: 'up1', fileName: 'Su faturası.jpg' }, target);
    expect(a).toEqual({ key: 'apartments/apt-1/invoices/2026/11/e9.jpg', fileName: 'Su faturası.jpg', contentType: 'image/jpeg', size: 500 });
    expect(mem.objects.has('apartments/apt-1/invoices/2026/11/e9.jpg')).toBe(true);

    mem.objects.set('tmp/apt-1/invoice-uploads/big', { body: new Uint8Array(10 * 1024 * 1024 + 1), contentType: 'application/pdf' });
    await expect(service.promoteInvoice(APT, { uploadId: 'big', fileName: 'b.pdf' }, target)).rejects.toMatchObject({ code: 'unprocessable' });
    mem.objects.set('tmp/apt-1/invoice-uploads/html', { body: new Uint8Array(5), contentType: 'text/html' });
    await expect(service.promoteInvoice(APT, { uploadId: 'html', fileName: 'b.html' }, target)).rejects.toMatchObject({ code: 'unprocessable' });
  });

  it('gider hareketinin faturasi imzali linkle verilir; faturasiz hareket 404', async () => {
    const { service } = setup();
    const r = await service.invoiceForTransaction(APT, 'tx-exp');
    expect(r).toMatchObject({ fileName: 'Elektrik Kasım.pdf', contentType: 'application/pdf' });
    expect(r.url).toContain('apartments/apt-1/invoices/2026/11/e1.pdf');
    expect(decodeURIComponent(r.url)).toContain(`filename*=UTF-8''Elektrik%20Kas%C4%B1m.pdf`);
    await expect(service.invoiceForTransaction(APT, 'tx-exp-none')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('documents rotalari', () => {
  function app(role: AuthClaims['role']) {
    const { service } = setup();
    return createApp({ version: 't', authenticate: () => ({ userId: 'u', role, apartmentId: APT }), documentsService: service });
  }
  const json = (body: object) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

  it('yonetici makbuz ve fatura alir; yanit onbelleklenmez', async () => {
    const res = await app('apartment_manager').request('/api/documents/receipts/by-transaction/tx-pay');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(((await res.json()) as { fileName: string }).fileName).toBe('Makbuz-MKB-000001.pdf');
    expect((await app('observer').request('/api/documents/invoices/by-transaction/tx-exp')).status).toBe(200);
  });

  it('rol sinirlari: sakin yonetici uclarina, yonetici sakin ucuna, denetci yuklemeye erisemez', async () => {
    const upload = json({ fileName: 'a.pdf', contentType: 'application/pdf', size: 1 });
    expect((await app('resident').request('/api/documents/receipts/by-transaction/tx-pay')).status).toBe(403);
    expect((await app('apartment_manager').request('/api/documents/my-receipts/p1')).status).toBe(403);
    expect((await app('building_staff').request('/api/documents/invoices/by-transaction/tx-exp')).status).toBe(403);
    expect((await app('observer').request('/api/documents/invoice-uploads', upload)).status).toBe(403);
    expect((await app('apartment_manager').request('/api/documents/invoice-uploads', upload)).status).toBe(201);
    expect((await app('resident').request('/api/documents/my-receipts/p1')).status).toBe(200);
  });

  it('hata kodlari: bulunamayan 404, gecersiz tur 422', async () => {
    expect((await app('apartment_manager').request('/api/documents/receipts/by-transaction/tx-due')).status).toBe(404);
    const res = await app('apartment_manager').request('/api/documents/invoice-uploads', json({ fileName: 'a.exe', contentType: 'application/x-msdownload', size: 1 }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'unprocessable' });
  });
});

describe('S3 belge deposu', () => {
  const s3 = mockClient(S3Client);
  const client = new S3Client({ region: 'eu-north-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' } });
  const store = createS3DocumentStore({ bucket: 'docs-bucket', client });
  beforeEach(() => s3.reset());

  it('olmayan nesne undefined; diger hatalar storage_error (502)', async () => {
    s3.on(HeadObjectCommand)
      .rejectsOnce(new NotFound({ message: 'nf', $metadata: { httpStatusCode: 404 } }))
      .rejectsOnce(new S3ServiceException({ name: 'InternalError', $fault: 'server', message: 'x', $metadata: { httpStatusCode: 500 } }))
      .resolvesOnce({ ContentLength: 12, ContentType: 'application/pdf' });
    expect(await store.head('a')).toBeUndefined();
    await expect(store.head('a')).rejects.toMatchObject({ code: 'storage_error', httpStatus: 502 });
    expect(await store.head('a')).toEqual({ size: 12, contentType: 'application/pdf' });
  });

  it('PDF yazimi ve kopya: dogru bucket, icerik turu ve kodlanmis kaynak', async () => {
    s3.on(PutObjectCommand).resolves({});
    s3.on(CopyObjectCommand).resolves({});
    await store.put('apartments/a/receipts/2026/11/p.pdf', new Uint8Array([1]), 'application/pdf');
    expect(s3.commandCalls(PutObjectCommand)[0]!.args[0].input).toMatchObject({ Bucket: 'docs-bucket', Key: 'apartments/a/receipts/2026/11/p.pdf', ContentType: 'application/pdf' });
    await store.copy('tmp/a/invoice-uploads/u 1', 'apartments/a/invoices/2026/11/e.pdf');
    expect(s3.commandCalls(CopyObjectCommand)[0]!.args[0].input).toMatchObject({ CopySource: 'docs-bucket/tmp/a/invoice-uploads/u%201', MetadataDirective: 'COPY' });
  });

  it('imzali linkler: 300 sn, GET indirme adi tasir, PUT icerik turunu imzalar', async () => {
    const get = new URL(await store.presignGet('apartments/a/x.pdf', { contentDisposition: 'inline; filename="x.pdf"', contentType: 'application/pdf', expiresIn: 300 }));
    expect(get.hostname).toContain('docs-bucket');
    expect(get.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(get.searchParams.get('response-content-disposition')).toBe('inline; filename="x.pdf"');

    const put = new URL(await store.presignPut('tmp/a/invoice-uploads/u1', { contentType: 'image/png', expiresIn: 300 }));
    expect(put.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
  });
});
