import { crc32, deflateRawSync } from 'node:zlib';
import { GenerateMacCommand, KMSClient } from '@aws-sdk/client-kms';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Role } from '../src/auth/claims.js';
import { BankError } from '../src/modules/finance/bank/errors.js';
import {
  createKmsIbanMacer,
  createLocalIbanMacer,
  extractIban,
  isValidTrIban,
  loadIbanMacer,
} from '../src/modules/finance/bank/iban.js';
import { statementFileKey } from '../src/modules/finance/bank/keys.js';
import { checkBalances, fingerprintLines, parseBankAmount, parseBankDate, parseLines, type ParsedLine } from '../src/modules/finance/bank/parse.js';
import { createBankService } from '../src/modules/finance/bank/service.js';
import { readSheet } from '../src/modules/finance/bank/sheet.js';
import { createMemoryBankFileStore } from '../src/modules/finance/bank/store.js';
import { detectHeader, foldHeader } from '../src/modules/finance/bank/templates.js';
import type { Account } from '../src/modules/finance/types.js';
import { createFakeBankRepo } from './fakes/bankRepo.js';

const APT = 'apt-bank-1';
const NOW = new Date('2026-11-22T07:00:00.000Z'); // Istanbul 22.11.2026

// ---------------------------------------------------------------------------
// Yardimcilar
// ---------------------------------------------------------------------------

/** Gecerli TR IBAN uretir (ISO 13616 mod-97): 22 haneli BBAN'dan kontrol haneleri hesaplanir. */
function trIban(bban22: string): string {
  const numeric = `${bban22}2927` + '00'; // T=29, R=27
  let rem = 0;
  for (const d of numeric) rem = (rem * 10 + Number(d)) % 97;
  return `TR${String(98 - rem).padStart(2, '0')}${bban22}`;
}
const IBAN_A = trIban('0006100519786457841326');
const IBAN_B = trIban('0001200940100005000123');
const spaced = (iban: string) => iban.replace(/(.{4})/g, '$1 ').trim();

/** Windows-1254 (Turkce) kodlama: test icin gereken karakterler. */
const CP1254: Record<string, number> = { Ğ: 0xd0, Ü: 0xdc, Ş: 0xde, İ: 0xdd, Ö: 0xd6, Ç: 0xc7, ğ: 0xf0, ü: 0xfc, ş: 0xfe, ı: 0xfd, ö: 0xf6, ç: 0xe7 };
function encode1254(s: string): Uint8Array {
  return Uint8Array.from([...s].map((ch) => CP1254[ch] ?? (ch.charCodeAt(0) < 128 ? ch.charCodeAt(0) : 0x3f)));
}

/** Minimal ZIP yazici (XLSX fixture'lari icin; deflate). */
function zip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8');
    const data = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

/** Ilk satiri baslik olan basit XLSX: metinler paylasilan dizgi, sayilar sayi hucresi. */
function xlsx(rows: (string | number | null)[][]): Uint8Array {
  const shared: string[] = [];
  const col = (i: number) => String.fromCharCode(65 + i);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rowXml = rows
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const ref = `${col(ci)}${ri + 1}`;
          if (v === null) return '';
          if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
          shared.push(v);
          return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');
  return zip({
    'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Ekstre" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rowXml}</sheetData></worksheet>`,
    'xl/sharedStrings.xml': `<sst>${shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`,
  });
}

/** Ziraat benzeri CSV: ust bilgi satirlari (apartmanin kendi IBAN'i), baslik, hareketler, toplam. */
function novemberCsv(): string {
  return [
    'Hesap Numarası;1234-5678',
    `IBAN;${spaced(IBAN_B)}`,
    '',
    'İşlem Tarihi;Açıklama;Tutar;Bakiye;Dekont No',
    `01.11.2026 09:15;HAVALE GÖNDEREN AYŞE YILMAZ ${IBAN_A} A-12 AİDAT;1.500,00;11.500,00;D001`,
    '02.11.2026;EFT ŞÜKRÜ ÇELİK B-3 KASIM;2.000,50;13.500,50;D002',
    '03.11.2026;ELEKTRİK FATURASI;-750,25;12.750,25;D003',
    ';Toplam;;;',
  ].join('\r\n');
}

// ---------------------------------------------------------------------------
// Dosya okuyucu
// ---------------------------------------------------------------------------

describe('ekstre dosya okuyucu', () => {
  it('CSV: Windows-1254 kodlamasi, ; ayirici, ust bilgi satirlari atlanip baslik bulunur', () => {
    const sheet = readSheet(encode1254(novemberCsv()));
    expect(sheet.format).toBe('csv');
    const header = detectHeader(sheet.rows);
    expect(header?.headerRowIndex).toBe(3);
    expect(header?.amountMode).toBe('signed');
    expect(header?.columns).toMatchObject({ date: 'İşlem Tarihi', description: 'Açıklama', amount: 'Tutar', balance: 'Bakiye', reference: 'Dekont No' });
  });

  it('CSV: UTF-8 BOM, virgul ayirici ve tirnak icinde ayirici/satir sonu', () => {
    const text = '﻿Tarih,Açıklama,Tutar\r\n"05.11.2026","KİRA, ""Kasım""\nödemesi","1.500,00"\r\n';
    const sheet = readSheet(new TextEncoder().encode(text));
    expect(sheet.rows[1]).toEqual(['05.11.2026', 'KİRA, "Kasım" ödemesi', '1.500,00']);
  });

  it('XLSX: paylasilan dizgiler, sayi hucreleri (Excel seri tarihi ve kayan nokta artigi)', () => {
    const bytes = xlsx([
      ['Tarih', 'Açıklama', 'Borç', 'Alacak', 'Bakiye'],
      [46327, 'AİDAT A-12', null, 1500.4999999999998, 11500.5],
      [46328, 'TEMİZLİK', 250, null, 11250.5],
    ]);
    const sheet = readSheet(bytes);
    expect(sheet.format).toBe('xlsx');
    const header = detectHeader(sheet.rows);
    expect(header?.amountMode).toBe('debit_credit');
    const { lines, errors } = parseLines(sheet, header as NonNullable<typeof header>, { maxLines: 100 });
    expect(errors).toEqual([]);
    expect(lines.map((l) => [l.date, l.direction, l.amount, l.balanceAfter])).toEqual([
      ['2026-11-01', 'in', 150050, 1150050],
      ['2026-11-02', 'out', 25000, 1125050],
    ]);
  });

  it('".xls" olarak inen HTML tablosu ve B/A yon sutunu', () => {
    const html = `<html><body><table>
      <tr><th>Tarih</th><th>Açıklama</th><th>Tutar</th><th>B/A</th><th>Bakiye</th></tr>
      <tr><td>04.11.2026</td><td>GELEN EFT &amp; HAVALE</td><td>1.000,00</td><td>A</td><td>5.000,00</td></tr>
      <tr><td>05.11.2026</td><td>ASANSÖR BAKIM</td><td>400,00</td><td>B</td><td>4.600,00</td></tr>
    </table></body></html>`;
    const sheet = readSheet(new TextEncoder().encode(html));
    expect(sheet.format).toBe('html');
    const header = detectHeader(sheet.rows);
    expect(header?.amountMode).toBe('amount_direction');
    const { lines } = parseLines(sheet, header as NonNullable<typeof header>, { maxLines: 100 });
    expect(lines.map((l) => [l.direction, l.amount, l.description])).toEqual([
      ['in', 100000, 'GELEN EFT & HAVALE'],
      ['out', 40000, 'ASANSÖR BAKIM'],
    ]);
  });

  it('eski ikili XLS ve PDF acik mesajla reddedilir', () => {
    const biff = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(() => readSheet(biff)).toThrow(/xlsx/i);
    try {
      readSheet(biff);
    } catch (err) {
      expect(err).toBeInstanceOf(BankError);
      expect((err as BankError).code).toBe('unsupported_format');
    }
    expect(() => readSheet(new TextEncoder().encode('%PDF-1.7 ...'))).toThrow(BankError);
  });
});

// ---------------------------------------------------------------------------
// Hucre yorumlama, parmak izi, bakiye
// ---------------------------------------------------------------------------

describe('tutar, tarih ve baslik yorumlama', () => {
  it('tutar bicimleri kurusa cevrilir (kayan nokta yok)', () => {
    expect(parseBankAmount('1.500,50')).toEqual({ kurus: 150050 });
    expect(parseBankAmount('+1.500,50 TL')).toEqual({ kurus: 150050 });
    expect(parseBankAmount('1.500,50-')).toEqual({ kurus: -150050 });
    expect(parseBankAmount('(250,10)')).toEqual({ kurus: -25010 });
    expect(parseBankAmount('1.500,00 B')).toEqual({ kurus: 150000, hint: 'out' });
    expect(parseBankAmount('1.500,00 A')).toEqual({ kurus: 150000, hint: 'in' });
    expect(parseBankAmount('1.500')).toEqual({ kurus: 150000 }); // Turkce binlik
    expect(parseBankAmount('1500.4999999999998')).toEqual({ kurus: 150050 });
    // XLSX sayi hucresi: nokta ondaliktir (metin olsa 1.500 = bin besyuz TL olurdu).
    expect(parseBankAmount('1.500', true)).toEqual({ kurus: 150 });
    // Ondalik metin uzerinden yuvarlama: 12.345 * 100 kayan noktada 1234.4999... olurdu.
    expect(parseBankAmount('12.345', true)).toEqual({ kurus: 1235 });
    expect(parseBankAmount('-250.1', true)).toEqual({ kurus: -25010 });
    expect(parseBankAmount('')).toBeUndefined();
    expect(parseBankAmount('abc')).toBeNull();
  });

  it('tarih + saat yazimlari', () => {
    expect(parseBankDate('05.11.2026 14:32')).toBe('2026-11-05');
    expect(parseBankDate('05/11/2026-14:32:11')).toBe('2026-11-05');
    expect(parseBankDate('2026-11-05T10:00:00')).toBe('2026-11-05');
    expect(parseBankDate('46331.58', true)).toBe('2026-11-05');
    expect(parseBankDate('')).toBeUndefined();
    expect(parseBankDate('31.02.2026')).toBeNull();
  });

  it('basliklar Turkce karakter ve noktalamadan bagimsiz katlanir', () => {
    expect(foldHeader('İşlem Tarihi')).toBe('islemtarihi');
    expect(foldHeader('Tutar (TL)')).toBe('tutartl');
    expect(foldHeader('B/A')).toBe('ba');
    expect(foldHeader('AÇIKLAMA')).toBe('aciklama');
  });
});

const L = (over: Partial<ParsedLine>): ParsedLine => ({ sourceRow: 1, date: '2026-11-01', direction: 'in', amount: 100000, description: 'AIDAT', ...over });

describe('parmak izi', () => {
  it('deterministik; hesap, tutar veya bakiye degisirse farkli', () => {
    const a = fingerprintLines('bank', [L({ balanceAfter: 500000 })])[0];
    const b = fingerprintLines('bank', [L({ balanceAfter: 500000 })])[0];
    expect(a?.fingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect(a?.fingerprint).toBe(b?.fingerprint);
    expect(fingerprintLines('bank-2', [L({ balanceAfter: 500000 })])[0]?.fingerprint).not.toBe(a?.fingerprint);
    expect(fingerprintLines('bank', [L({ balanceAfter: 600000 })])[0]?.fingerprint).not.toBe(a?.fingerprint);
    // Aciklamadaki bosluk farki ayni hareket sayilir.
    expect(fingerprintLines('bank', [L({ balanceAfter: 500000, description: '  AIDAT ' })])[0]?.fingerprint).toBe(a?.fingerprint);
  });

  it('bakiye/referans yoksa ayni gun ayni iki hareket sira numarasiyla ayrilir (zayif iz)', () => {
    const fps = fingerprintLines('bank', [L({}), L({}), L({ date: '2026-11-02' })]);
    expect(fps.map((f) => f.weak)).toEqual([true, true, true]);
    expect(fps[0]?.fingerprint).not.toBe(fps[1]?.fingerprint);
    expect(fps.some((f) => f.duplicateInFile)).toBe(false);
    // Ayni gunu tam iceren baska bir ekstre ayni izleri uretir.
    const again = fingerprintLines('bank', [L({}), L({})]);
    expect(again.map((f) => f.fingerprint)).toEqual([fps[0]?.fingerprint, fps[1]?.fingerprint]);
  });

  it('guclu izde (referans var) ayni satir ikinci kez gelirse dosya ici tekrardir', () => {
    const fps = fingerprintLines('bank', [L({ bankReference: 'D1' }), L({ bankReference: 'D1' }), L({ bankReference: 'D2' })]);
    expect(fps.map((f) => f.duplicateInFile)).toEqual([false, true, false]);
  });
});

describe('bakiye surekliligi', () => {
  const lines = [
    L({ amount: 150000, balanceAfter: 1150000 }),
    L({ amount: 200050, balanceAfter: 1350050 }),
    L({ direction: 'out', amount: 75025, balanceAfter: 1275025 }),
  ];

  it('eskiden yeniye: acilis/kapanis bakiyesi', () => {
    const r = checkBalances(lines);
    expect(r.order).toBe('asc');
    expect(r.mismatches.size).toBe(0);
    expect(r.openingBalance).toBe(1000000);
    expect(r.closingBalance).toBe(1275025);
  });

  it('yeniden eskiye siralanmis ekstre de tutarli bulunur', () => {
    const r = checkBalances([...lines].reverse());
    expect(r.order).toBe('desc');
    expect(r.mismatches.size).toBe(0);
    expect(r.openingBalance).toBe(1000000);
    expect(r.closingBalance).toBe(1275025);
  });

  it('tutmayan satir isaretlenir', () => {
    const broken = [...lines.slice(0, 2), L({ direction: 'out', amount: 75025, balanceAfter: 1200000 }), L({ amount: 10000, balanceAfter: 1210000 })];
    const r = checkBalances(broken);
    expect(r.order).toBe('asc');
    expect([...r.mismatches]).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// IBAN maskeleme ve HMAC
// ---------------------------------------------------------------------------

describe('IBAN maskeleme ve HMAC ozeti', () => {
  it('fixture IBANlari gecerli', () => {
    expect(isValidTrIban(IBAN_A)).toBe(true);
    expect(isValidTrIban(IBAN_B)).toBe(true);
  });

  it('bosluklu IBAN ayiklanir, metinde yalnizca maskeli hali kalir', () => {
    const r = extractIban(`GONDEREN ${spaced(IBAN_A)} AIDAT`);
    expect(r.iban).toBe(IBAN_A);
    expect(r.text).not.toContain(IBAN_A.slice(4, 20));
    expect(r.text).toContain(`**${IBAN_A.slice(-4, -2)} ${IBAN_A.slice(-2)}`);
  });

  it('gecersiz (mod-97) IBAN dondurulmez ama yine de maskelenir', () => {
    const bad = `TR00${IBAN_A.slice(4)}`;
    const r = extractIban(`X ${bad} Y`);
    expect(r.iban).toBeUndefined();
    expect(r.text).not.toContain(bad);
  });

  it('yerel HMAC deterministik ve apartmana ozgu', async () => {
    const m = createLocalIbanMacer();
    const a1 = await m.mac(APT, IBAN_A);
    expect(a1).toMatch(/^l1:[A-Za-z0-9_-]{43}$/);
    expect(await m.mac(APT, spaced(IBAN_A).toLowerCase())).toBe(a1);
    expect(await m.mac('apt-other', IBAN_A)).not.toBe(a1);
    expect(a1).not.toContain(IBAN_A);
  });

  it('KMS GenerateMac: anahtar, algoritma ve apartmanli mesaj; k1 oneki', async () => {
    const kms = mockClient(KMSClient);
    kms.on(GenerateMacCommand).resolves({ Mac: Uint8Array.from({ length: 32 }, (_, i) => i) });
    const keyId = 'arn:aws:kms:eu-north-1:123456789012:key/5b2f7c1e-0d6a-4c1f-9e3b-6a7d8c9b0a12';
    const m = createKmsIbanMacer({ keyId, client: new KMSClient({ region: 'eu-north-1' }) });
    const out = await m.mac(APT, IBAN_A);
    expect(out).toBe(`k1:${Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i)).toString('base64url')}`);
    const input = kms.commandCalls(GenerateMacCommand)[0]?.args[0].input;
    expect(input?.KeyId).toBe(keyId);
    expect(input?.MacAlgorithm).toBe('HMAC_SHA_256');
    expect(Buffer.from(input?.Message as Uint8Array).toString('utf8')).toBe(`bank-iban:v1|${APT}|${IBAN_A}`);

    kms.reset();
    kms.on(GenerateMacCommand).rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    await expect(m.mac(APT, IBAN_A)).rejects.toMatchObject({ code: 'unavailable' });
    kms.restore();
  });

  it('production ortaminda anahtar yoksa HMAC yok (yerel yedege dusulmez); gecersiz ARN reddedilir', () => {
    expect(loadIbanMacer({ NODE_ENV: 'production' })).toBeUndefined();
    expect(loadIbanMacer({ AWS_LAMBDA_FUNCTION_NAME: 'api' })).toBeUndefined();
    expect(loadIbanMacer({ NODE_ENV: 'test' })?.kind).toBe('local');
    expect(() => loadIbanMacer({ BANK_IBAN_MAC_KEY_ID: 'not-an-arn' })).toThrow(/ARN/);
    const stub = () => ({ send: async () => ({}) }) as unknown as KMSClient;
    expect(loadIbanMacer({ BANK_IBAN_MAC_KEY_ID: 'arn:aws:kms:eu-north-1:123456789012:alias/x-bank-iban-hmac' }, stub)?.kind).toBe('kms');
  });
});

// ---------------------------------------------------------------------------
// API akisi
// ---------------------------------------------------------------------------

describe('/api/bank', () => {
  let role: Role;
  let fake: ReturnType<typeof createFakeBankRepo>;
  let files: ReturnType<typeof createMemoryBankFileStore>;
  let app: ReturnType<typeof createApp>;
  let seq: number;

  const accounts: Record<string, Partial<Account>> = {
    bank: { accountId: 'bank', type: 'bank', status: 'active' },
    'bank-2': { accountId: 'bank-2', type: 'bank', status: 'active' },
    cash: { accountId: 'cash', type: 'cash', status: 'active' },
  };

  beforeEach(() => {
    role = 'apartment_manager';
    seq = 0;
    fake = createFakeBankRepo();
    files = createMemoryBankFileStore();
    const service = createBankService({
      repo: fake.repo,
      store: files.store,
      macer: createLocalIbanMacer(),
      accounts: { getAccount: async (_apt, id) => accounts[id] as Account | undefined },
      now: () => NOW,
      newId: () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, '0')}`,
    });
    app = createApp({ version: 't', authenticate: () => ({ userId: 'u-manager', role, apartmentId: APT }), bankService: service });
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };

  /** Yukleme linki al + dosyayi "yukle" + onizle. */
  async function upload(bytes: Uint8Array, opts: { bankAccountId?: string; fileName?: string; format?: unknown } = {}) {
    const bankAccountId = opts.bankAccountId ?? 'bank';
    const u = await call('POST', '/api/bank/statements/upload-url', { bankAccountId, fileName: opts.fileName ?? 'ekstre.csv', contentType: 'text/csv', size: bytes.byteLength });
    expect(u.status).toBe(201);
    files.objects.set(statementFileKey(APT, u.json.statementId), { body: bytes, contentType: 'text/csv' });
    const p = await call('POST', '/api/bank/statements', {
      statementId: u.json.statementId,
      bankAccountId,
      fileName: opts.fileName ?? 'ekstre.csv',
      ...(opts.format ? { format: opts.format } : {}),
    });
    return { statementId: u.json.statementId as string, preview: p };
  }

  it('upload-url: imzali PUT, apartman ve ay bazli S3 yolu', async () => {
    const r = await call('POST', '/api/bank/statements/upload-url', { bankAccountId: 'bank', fileName: 'kasim.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 2048 });
    expect(r.status).toBe(201);
    expect(r.json.statementId).toMatch(/^20261122-/);
    expect(r.json.uploadUrl).toContain(`memory://put/apartments/${APT}/bank-statements/2026/11/${r.json.statementId}`);
    expect(r.json.uploadUrl).toContain('len=2048');
    expect(r.json.headers).toEqual({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(r.json.method).toBe('PUT');
  });

  it('upload-url: banka disi hesap, buyuk dosya ve desteklenmeyen tur reddedilir', async () => {
    expect((await call('POST', '/api/bank/statements/upload-url', { bankAccountId: 'cash', fileName: 'a.csv', contentType: 'text/csv', size: 10 })).status).toBe(422);
    expect((await call('POST', '/api/bank/statements/upload-url', { bankAccountId: 'yok', fileName: 'a.csv', contentType: 'text/csv', size: 10 })).status).toBe(422);
    expect((await call('POST', '/api/bank/statements/upload-url', { bankAccountId: 'bank', fileName: 'a.csv', contentType: 'text/csv', size: 6 * 1024 * 1024 })).status).toBe(413);
    expect((await call('POST', '/api/bank/statements/upload-url', { bankAccountId: 'bank', fileName: 'a.pdf', contentType: 'application/pdf', size: 10 })).status).toBe(422);
  });

  it('onizleme: satirlar, maskeli IBAN, bakiye ve donem; denetim kaydi; duz IBAN hicbir yerde yok', async () => {
    const { statementId, preview } = await upload(encode1254(novemberCsv()));
    expect(preview.status).toBe(200);
    const st = preview.json.statement;
    expect(st).toMatchObject({
      statementId,
      status: 'previewed',
      version: 1,
      sourceFormat: 'csv',
      formatSource: 'detected',
      lineCount: 3,
      period: { from: '2026-11-01', to: '2026-11-03' },
      openingBalance: 1000000,
      closingBalance: 1275025,
      credits: { count: 2, amount: 350050 },
      debits: { count: 1, amount: 75025 },
    });
    expect(st.issues).toMatchObject({ errors: 0, duplicatesInFile: 0, duplicatesExisting: 0, balanceMismatches: 0, weakFingerprints: 0, ignoredRows: 1 });
    expect(st.fileKey).toBeUndefined();
    expect(preview.json.header.row).toBe(4);
    const first = preview.json.lines[0];
    expect(first).toMatchObject({ sourceRow: 5, date: '2026-11-01', direction: 'in', amount: 150000, bankReference: 'D001', flags: [] });
    expect(first.counterpartyIbanMasked).toBe(`TR** **** **** **** **** **${IBAN_A.slice(-4, -2)} ${IBAN_A.slice(-2)}`);
    expect(first.description).toContain('A-12 AİDAT');
    expect(preview.json.warnings).toEqual([]);

    const everything = JSON.stringify(preview.json) + JSON.stringify([...fake.items.values()]);
    for (const iban of [IBAN_A, IBAN_B]) expect(everything).not.toContain(iban.slice(4));
    expect(fake.audits.map((a) => a.action)).toEqual(['bank.statement.preview']);
    expect(fake.lines(APT)).toHaveLength(0); // onizleme satir yazmaz
  });

  it('aktarim: surum ister, satirlari HMAC ozetiyle yazar, denetlenir ve tekrar cagrilabilir', async () => {
    const { statementId, preview } = await upload(encode1254(novemberCsv()));
    expect((await call('POST', `/api/bank/statements/${statementId}/commit`, {})).status).toBe(409);
    expect((await call('POST', `/api/bank/statements/${statementId}/commit`, { expectedVersion: 7 })).json.error).toBe('version_conflict');

    const c = await call('POST', `/api/bank/statements/${statementId}/commit`, { expectedVersion: preview.json.statement.version });
    expect(c.status).toBe(200);
    expect(c.json).toMatchObject({ alreadyCommitted: false, written: 3, existing: 0 });
    expect(c.json.statement.status).toBe('committed');
    expect(c.json.statement.committed).toMatchObject({ newLines: 3, existingLines: 0, committedBy: 'u-manager' });

    const lines = fake.lines(APT);
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.status === 'unmatched' && l.version === 1 && l.statementId === statementId)).toBe(true);
    expect(lines[0]?.SK).toMatch(/^BANKTX#bank#2026-11-01#[0-9a-f]{24}$/);
    const withIban = lines.find((l) => l.counterpartyIbanMac);
    expect(withIban?.counterpartyIbanMac).toBe(await createLocalIbanMacer().mac(APT, IBAN_A));
    expect(JSON.stringify(lines)).not.toContain(IBAN_A.slice(4));
    expect(fake.audits.map((a) => a.action)).toEqual(['bank.statement.preview', 'bank.statement.commit']);
    expect(fake.audits[1]?.details).toMatchObject({ bankAccountId: 'bank', committed: { newLines: 3, existingLines: 0 } });

    const again = await call('POST', `/api/bank/statements/${statementId}/commit`, { expectedVersion: 1 });
    expect(again.json).toMatchObject({ alreadyCommitted: true, written: 0 });
    expect(fake.lines(APT)).toHaveLength(3);
    // Aktarilmis ekstre yeniden onizlenemez.
    const re = await call('POST', '/api/bank/statements', { statementId, bankAccountId: 'bank', fileName: 'x.csv' });
    expect(re.json.error).toBe('already_committed');
  });

  it('ayni dosya ikinci kez yuklenemez (BANKFILE kilidi)', async () => {
    const bytes = encode1254(novemberCsv());
    const first = await upload(bytes);
    const second = await upload(bytes);
    expect(second.preview.status).toBe(409);
    expect(second.preview.json).toMatchObject({ error: 'duplicate_file', existingStatementId: first.statementId, status: 'previewed' });
  });

  it('cakisan donem: onceden aktarilmis satirlar isaretlenir ve tekrar yazilmaz', async () => {
    const one = await upload(encode1254(novemberCsv()));
    await call('POST', `/api/bank/statements/${one.statementId}/commit`, { expectedVersion: 1 });

    const overlapping = [
      'İşlem Tarihi;Açıklama;Tutar;Bakiye;Dekont No',
      '02.11.2026;EFT ŞÜKRÜ ÇELİK B-3 KASIM;2.000,50;13.500,50;D002',
      '03.11.2026;ELEKTRİK FATURASI;-750,25;12.750,25;D003',
      '04.11.2026;HAVALE C-7 AİDAT;1.250,00;14.000,25;D004',
    ].join('\n');
    const two = await upload(encode1254(overlapping), { fileName: 'kasim-2.csv' });
    expect(two.preview.status).toBe(200);
    expect(two.preview.json.statement.issues).toMatchObject({ duplicatesExisting: 2, overlappingStatements: [one.statementId] });
    expect(two.preview.json.lines.map((l: any) => l.flags)).toEqual([['duplicate_existing'], ['duplicate_existing'], []]);
    // Guclu izlerde cakisma uyarisi gerekmez.
    expect(two.preview.json.warnings).toEqual([]);

    const c = await call('POST', `/api/bank/statements/${two.statementId}/commit`, { expectedVersion: 1 });
    expect(c.json).toMatchObject({ written: 1, existing: 2 });
    expect(fake.lines(APT)).toHaveLength(4);
    expect(fake.lines(APT).filter((l) => l.statementId === one.statementId)).toHaveLength(3);
  });

  it('bakiye tutarsizligi: aktarim icin uyari onayi gerekir', async () => {
    const csv = ['Tarih;Açıklama;Tutar;Bakiye;Referans', '01.11.2026;A;100,00;1.100,00;R1', '02.11.2026;B;100,00;1.150,00;R2'].join('\n');
    const { statementId, preview } = await upload(new TextEncoder().encode(csv));
    expect(preview.json.statement.issues.balanceMismatches).toBe(1);
    expect(preview.json.lines[1].flags).toContain('balance_mismatch');
    const denied = await call('POST', `/api/bank/statements/${statementId}/commit`, { expectedVersion: 1 });
    expect(denied.status).toBe(422);
    expect(denied.json.error).toBe('warnings_unacknowledged');
    expect(denied.json.warnings[0]).toMatch(/bakiye/);
    const ok = await call('POST', `/api/bank/statements/${statementId}/commit`, { expectedVersion: 1, acknowledgeWarnings: true });
    expect(ok.json.written).toBe(2);
  });

  it('okunamayan satir aktarilmaz ve onay ister; dosya ici tekrar ve zayif iz isaretlenir', async () => {
    const csv = [
      'Tarih;Açıklama;Tutar',
      '01.11.2026;AIDAT A-1;100,00',
      '01.11.2026;AIDAT A-1;100,00',
      '32.11.2026;BOZUK;100,00',
      '02.11.2026;X;abc',
    ].join('\n');
    const { statementId, preview } = await upload(new TextEncoder().encode(csv));
    expect(preview.json.errors.map((e: any) => [e.row, e.field])).toEqual([
      [4, 'date'],
      [5, 'amount'],
    ]);
    expect(preview.json.lines.map((l: any) => l.flags)).toEqual([['weak_fingerprint'], ['weak_fingerprint']]);
    expect(preview.json.statement.issues).toMatchObject({ errors: 2, weakFingerprints: 2 });
    const ok = await call('POST', `/api/bank/statements/${statementId}/commit`, { expectedVersion: 1, acknowledgeWarnings: true });
    expect(ok.json.written).toBe(2);
  });

  it('dosya onizlemeden sonra degisirse aktarim reddedilir', async () => {
    const { statementId } = await upload(encode1254(novemberCsv()));
    files.objects.set(statementFileKey(APT, statementId), { body: new TextEncoder().encode('Tarih;Açıklama;Tutar\n01.11.2026;Z;1,00'), contentType: 'text/csv' });
    const r = await call('POST', `/api/bank/statements/${statementId}/commit`, { expectedVersion: 1 });
    expect(r.json.error).toBe('file_changed');
    expect(fake.lines(APT)).toHaveLength(0);
  });

  it('baslik taninmazsa maskeli ornek satirlarla 422; elle esleme ile onizlenir', async () => {
    const csv = [`Hesap;${IBAN_B}`, 'Gün;Not;Para', '01.11.2026;AIDAT;100,00'].join('\n');
    const bytes = new TextEncoder().encode(csv);
    const { statementId, preview } = await upload(bytes);
    expect(preview.status).toBe(422);
    expect(JSON.stringify(preview.json.sampleRows)).not.toContain(IBAN_B.slice(4));
    const manual = await call('POST', '/api/bank/statements', {
      statementId,
      bankAccountId: 'bank',
      fileName: 'x.csv',
      format: { amountMode: 'signed', columns: { date: 'Gün', description: 'Not', amount: 'Para' } },
    });
    expect(manual.status).toBe(200);
    expect(manual.json.statement).toMatchObject({ formatSource: 'request', lineCount: 1 });
  });

  it('hesaba kayitli esleme: surum kosullu kayit ve onizlemede kullanimi', async () => {
    const format = { amountMode: 'signed', columns: { date: 'Gün', description: 'Not', amount: 'Para' } };
    const created = await call('PUT', '/api/bank/formats/bank', { format });
    expect(created.status).toBe(200);
    expect(created.json.version).toBe(1);
    expect((await call('PUT', '/api/bank/formats/bank', { format })).json.error).toBe('version_conflict');
    expect((await call('PUT', '/api/bank/formats/bank', { format, expectedVersion: 5 })).json.error).toBe('version_conflict');
    const updated = await call('PUT', '/api/bank/formats/bank', { format: { ...format, headerRow: 1 }, expectedVersion: 1 });
    expect(updated.json.version).toBe(2);
    expect((await call('GET', '/api/bank/formats/bank')).json).toMatchObject({ format: { headerRow: 1 }, version: 2 });
    expect(fake.audits.filter((a) => a.action === 'bank.format.save')).toHaveLength(2);

    const { preview } = await upload(new TextEncoder().encode('Gün;Not;Para\n01.11.2026;AIDAT;100,00'));
    expect(preview.json.statement.formatSource).toBe('saved');

    const { preview: mismatch } = await upload(new TextEncoder().encode('Tarih;Açıklama;Tutar\n01.11.2026;AIDAT;200,00'));
    expect(mismatch.status).toBe(422);
    expect(mismatch.json.expectedHeaders).toEqual(['Gün', 'Not', 'Para']);

    expect((await call('PUT', '/api/bank/formats/bank', { format: { amountMode: 'signed', columns: { date: 'A' } }, expectedVersion: 2 })).status).toBe(422);
  });

  it('satir listesi: hesap zorunlu, durum/tarih filtresi ve sayfalama', async () => {
    const { statementId } = await upload(encode1254(novemberCsv()));
    await call('POST', `/api/bank/statements/${statementId}/commit`, { expectedVersion: 1 });
    expect((await call('GET', '/api/bank/lines')).status).toBe(422);
    const all = await call('GET', '/api/bank/lines?bankAccountId=bank&order=asc');
    expect(all.json.items.map((l: any) => l.date)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect(all.json.items[0].counterpartyIbanMac).toBeUndefined();
    expect(all.json.items[0].SK).toBeUndefined();
    const ranged = await call('GET', '/api/bank/lines?bankAccountId=bank&from=2026-11-02&to=2026-11-02&status=unmatched');
    expect(ranged.json.items).toHaveLength(1);
    const p1 = await call('GET', '/api/bank/lines?bankAccountId=bank&limit=2');
    expect(p1.json.items.map((l: any) => l.date)).toEqual(['2026-11-03', '2026-11-02']);
    const p2 = await call('GET', `/api/bank/lines?bankAccountId=bank&limit=2&cursor=${p1.json.cursor}`);
    expect(p2.json.items.map((l: any) => l.date)).toEqual(['2026-11-01']);
    expect(p2.json.cursor).toBeUndefined();
    // Baska apartmanin anahtarini tasiyan imlec reddedilir.
    const forged = Buffer.from(JSON.stringify({ PK: 'APT#baska', SK: 'BANKTX#bank#2026-11-03#000000000000000000000000' })).toString('base64url');
    expect((await call('GET', `/api/bank/lines?bankAccountId=bank&cursor=${forged}`)).status).toBe(422);
  });

  it('ekstre listesi ve ayrinti', async () => {
    const one = await upload(encode1254(novemberCsv()));
    const list = await call('GET', '/api/bank/statements?bankAccountId=bank');
    expect(list.json.items.map((s: any) => s.statementId)).toEqual([one.statementId]);
    expect((await call('GET', '/api/bank/statements?bankAccountId=bank-2')).json.items).toEqual([]);
    const detail = await call('GET', `/api/bank/statements/${one.statementId}`);
    expect(detail.json.statement.status).toBe('previewed');
    expect((await call('GET', '/api/bank/statements/20261122-00000000-0000-4000-8000-00000000ffff')).status).toBe(404);
    expect((await call('GET', '/api/bank/templates')).json.items[0]).toMatchObject({ id: 'generic', verified: false });
  });

  it('yetki: denetci okur ama yazamaz; sakin ve gorevli erisemez', async () => {
    const one = await upload(encode1254(novemberCsv()));
    role = 'observer';
    expect((await call('GET', '/api/bank/statements')).status).toBe(200);
    expect((await call('GET', '/api/bank/lines?bankAccountId=bank')).status).toBe(200);
    expect((await call('GET', '/api/bank/formats/bank')).status).toBe(200);
    expect((await call('POST', '/api/bank/statements/upload-url', { bankAccountId: 'bank', fileName: 'a.csv', contentType: 'text/csv', size: 10 })).status).toBe(403);
    expect((await call('POST', `/api/bank/statements/${one.statementId}/commit`, { expectedVersion: 1 })).status).toBe(403);
    expect((await call('PUT', '/api/bank/formats/bank', { format: {} })).status).toBe(403);
    for (const r of ['resident', 'building_staff', 'security_guard'] as Role[]) {
      role = r;
      expect((await call('GET', '/api/bank/statements')).status).toBe(403);
    }
    role = 'management_company';
    expect((await call('POST', `/api/bank/statements/${one.statementId}/commit`, { expectedVersion: 1 })).status).toBe(200);
  });

  it('depolama veya HMAC anahtari yoksa 503', async () => {
    const noStore = createBankService({ repo: fake.repo, store: undefined, macer: createLocalIbanMacer(), accounts: { getAccount: async () => accounts.bank as Account }, now: () => NOW });
    const app2 = createApp({ version: 't', authenticate: () => ({ userId: 'u', role: 'apartment_manager', apartmentId: APT }), bankService: noStore });
    const r = await app2.request('/api/bank/statements/upload-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bankAccountId: 'bank', fileName: 'a.csv', contentType: 'text/csv', size: 10 }),
    });
    expect(r.status).toBe(503);

    const { statementId } = await upload(encode1254(novemberCsv()));
    const noMac = createBankService({ repo: fake.repo, store: files.store, macer: undefined, accounts: { getAccount: async () => accounts.bank as Account }, now: () => NOW });
    const app3 = createApp({ version: 't', authenticate: () => ({ userId: 'u', role: 'apartment_manager', apartmentId: APT }), bankService: noMac });
    const c = await app3.request(`/api/bank/statements/${statementId}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(c.status).toBe(503);
    expect(fake.lines(APT)).toHaveLength(0);
  });
});
