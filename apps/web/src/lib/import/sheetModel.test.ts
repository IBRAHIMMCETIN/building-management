import { describe, expect, it, vi } from 'vitest';
import { type ImportPlan, type ImportRunApi, initialRunState, kurusToApiText, runImport, summarize } from './runImport';
import {
  FRACTION_AS_DATE,
  SHEETS,
  type ImportRow,
  type SheetKind,
  cellToText,
  detectKind,
  normalizeHeader,
  parseCsv,
  parseSheet,
  parseWorkbook,
  reportTable,
  toChunks,
  toCsv,
  withoutRows,
} from './sheetModel';

describe('baslik ve hucre donusumu', () => {
  it('Turkce basliklar sadelesir', () => {
    expect(normalizeHeader('Brüt m²*')).toBe('brutm2');
    expect(normalizeHeader('İLİŞKİ')).toBe('iliski');
    expect(normalizeHeader('E-posta')).toBe('eposta');
    expect(normalizeHeader('Başlangıç Tarihi')).toBe('baslangictarihi');
  });

  it('hucreler metne cevrilir: tarih (UTC gun), sayi gurultusu, kesir-tarih isareti', () => {
    expect(cellToText(new Date(Date.UTC(2026, 9, 10)))).toBe('2026-10-10');
    expect(cellToText(1500.1000000000001)).toBe('1500.1');
    expect(cellToText(-250)).toBe('-250');
    expect(cellToText(true)).toBe('Evet');
    expect(cellToText('  ')).toBeUndefined();
    expect(cellToText(new Date(Date.UTC(2026, 0, 4)), { fraction: true })).toBe(FRACTION_AS_DATE);
    // Sunucu ile ayni isaret (apps/api/src/modules/imports/parse.ts DATE_IN_FRACTION).
    expect(FRACTION_AS_DATE).toBe('#TARIH#');
  });

  it('sayfa turu ad veya basliktan bulunur', () => {
    expect(detectKind('Kişiler', [])).toBe('people');
    expect(detectKind('Sayfa1', ['Blok', 'Daire No', 'E-posta'])).toBe('people');
    expect(detectKind(undefined, ['Blok', 'Daire', 'Cari', 'Tutar'])).toBe('balances');
    expect(detectKind('x', ['Blok', 'No', 'm2'])).toBe('units');
    expect(detectKind('x', ['a', 'b'])).toBeUndefined();
  });
});

describe('sablon sutun bicimleri', () => {
  it('tarih, kesir ve kimlik sutunlari metin; yalnizca kat, m2 ve tutar sayi', () => {
    const numeric = Object.values(SHEETS).flatMap((d) => d.columns.filter((c) => c.numeric).map((c) => `${d.kind}.${c.key}`));
    expect(numeric).toEqual(['units.floor', 'units.area', 'balances.amount']);
    const dates = Object.values(SHEETS).flatMap((d) => d.columns.filter((c) => c.date).map((c) => `${d.kind}.${c.key}`));
    expect(dates).toEqual(['people.startDate', 'balances.dueDate']);
    const fractions = Object.values(SHEETS).flatMap((d) => d.columns.filter((c) => c.fraction).map((c) => `${d.kind}.${c.key}`));
    expect(fractions).toEqual(['units.landShare', 'people.share']);
    // Her sutunun ornegi var ve ornek satirin blogu atlanan isaret.
    for (const d of Object.values(SHEETS)) {
      expect(d.columns.every((c) => c.sample !== undefined)).toBe(true);
      expect(d.columns[0]?.sample).toBe('Örnek');
    }
  });
});

describe('sayfa ayristirma', () => {
  it('satir numarasi dosyadakiyle ayni; bos satir ve bilinmeyen sutun atlanir', () => {
    const r = parseSheet('Daireler', [
      [null, null],
      ['Blok*', 'Daire No*', 'Brüt m²*', 'Not', 'Arsa Payı'],
      ['A Blok', 1, 100.5, 'x', '12/480'],
      [null, '', null, null, null],
      ['A Blok', '2', 90, null, null],
    ]);
    expect(r).toEqual({
      ok: true,
      kind: 'units',
      ignoredColumns: ['Not'],
      rows: [
        { row: 3, block: 'A Blok', number: '1', area: '100.5', landShare: '12/480' },
        { row: 5, block: 'A Blok', number: '2', area: '90' },
      ],
    });
  });

  it('bicim ipuclu basliklar eslesir; gri ornek satir (Blok = Örnek) aktarilmaz', () => {
    const r = parseSheet('Kişiler', [
      ['Blok*', 'Daire No*', 'Ad Soyad*', 'E-posta*', 'İlişki*', 'Başlangıç Tarihi (YYYY-AA-GG)', 'Hisse (Örn: 1/1)'],
      ['Örnek', '1', 'Mehmet Kaya', 'mehmet@ornek.com', 'Malik', new Date(Date.UTC(2026, 0, 1)), '1/1'],
      ['A', '1', 'Ali Veli', 'ali@site.com', 'Malik', 1012026, new Date(Date.UTC(2026, 0, 1))],
    ]);
    expect(r).toMatchObject({ ok: true, ignoredColumns: [] });
    expect(r.ok && r.rows).toEqual([
      // Sayiya donmus tarih sunucuya metin gider (sunucu kurtarir); kesirdeki tarih isaretlenir.
      { row: 3, block: 'A', number: '1', fullName: 'Ali Veli', email: 'ali@site.com', relation: 'Malik', startDate: '1012026', share: FRACTION_AS_DATE },
    ]);
  });

  it('zorunlu sutun eksikse sayfa reddedilir', () => {
    const r = parseSheet('Bakiyeler', [['Blok', 'Daire No', 'Cari']]);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('Tutar') });
  });

  it('calisma kitabi: aciklama sayfasi atlanir, ayni tur iki kez hata, 1000 siniri', () => {
    const units = [['Blok', 'Daire No', 'Brüt m²'], ['A', '1', '50']];
    const ok = parseWorkbook([{ name: 'Daireler', data: units }, { name: 'Açıklama', data: [['Sayfa', 'Sütun']] }, { name: 'Kişiler', data: [] }]);
    expect(ok).toMatchObject({ errors: [], total: 1 });
    expect(parseWorkbook([{ name: 'Daireler', data: units }, { name: 'units', data: units }]).errors[0]).toMatch(/birden fazla/);
    const big = [['Blok', 'Daire No', 'Brüt m²'], ...Array.from({ length: 1001 }, (_, i) => ['A', String(i), '50'])];
    expect(parseWorkbook([{ name: 'Daireler', data: big }]).errors[0]).toMatch(/1000/);
    expect(parseWorkbook([{ name: 'Daireler', data: [['Blok', 'Daire No', 'Brüt m²']] }]).errors[0]).toMatch(/satır bulunamadı/);
  });
});

describe('CSV', () => {
  it('noktali virgul, tirnak, BOM ve CRLF', () => {
    expect(parseCsv('﻿Blok;Tutar;Açıklama\r\nA;"1.250,50";"Eski ""aidat""; borç"\r\n')).toEqual([
      ['Blok', 'Tutar', 'Açıklama'],
      ['A', '1.250,50', 'Eski "aidat"; borç'],
    ]);
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('rapor CSV olarak geri yazilir (Excel TR icin ; ve BOM)', () => {
    const table = reportTable([{ sheet: 'people', row: 4, label: 'A · 1', message: 'E-posta; geçersiz' }]);
    expect(toCsv(table)).toBe('﻿Sayfa;Satır;Kayıt;Hata\r\nKişiler;4;A · 1;"E-posta; geçersiz"\r\n');
  });
});

describe('parcalama', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ row: i + 2 }));
  it('daireler -> kisiler -> bakiyeler, en fazla 25', () => {
    const chunks = toChunks({ units: rows(30), people: rows(3), balances: rows(25) });
    expect(chunks.map((c) => [c.kind, c.rows.length])).toEqual([
      ['units', 25],
      ['units', 5],
      ['people', 3],
      ['balances', 25],
    ]);
  });
  it('hatali satirlar atlanabilir', () => {
    expect(withoutRows({ units: rows(3), people: rows(2), balances: [] }, [{ sheet: 'units', row: 3 }]).units.map((r) => r.row)).toEqual([2, 4]);
  });
});

describe('yurutucu', () => {
  const plan: ImportPlan = {
    importId: 'imp_1',
    asOfDate: '2026-10-31',
    fileName: 'v.xlsx',
    sheets: {
      units: Array.from({ length: 30 }, (_, i) => ({ row: i + 2, block: 'A', number: String(i), area: '50' })),
      people: [],
      balances: [{ row: 2, block: 'A', number: '1', party: 'Oturan', amount: '100' }],
    },
    cash: 500000,
    bank: 0,
  };
  const job = { importId: 'imp_1', fileName: 'v.xlsx', asOfDate: '2026-10-31', status: 'completed' as const, totals: { units: 30, people: 0, balances: 1 }, createdAt: 'x', version: 2 };

  function api(failAt?: number): ImportRunApi & { calls: string[] } {
    const calls: string[] = [];
    let n = 0;
    return {
      calls,
      start: vi.fn(async () => job),
      rows: vi.fn(async (_id: string, kind: SheetKind, rows: ImportRow[]) => {
        if (n++ === failAt) throw new Error('ag');
        calls.push(`${kind}:${rows.length}`);
        return { results: rows.map((r) => ({ sheet: kind, row: r.row, label: 'x', outcome: r.row === 3 ? ('error' as const) : ('created' as const), message: 'm' })) };
      }),
      funds: vi.fn(async () => ({ funds: [{ account: 'cash' as const, outcome: 'created' as const }] })),
      complete: vi.fn(async () => job),
    };
  }

  it('sirayla yazar, kasayi metin tutar olarak gonderir, tamamlar', async () => {
    const a = api();
    const progress = vi.fn();
    const s = await runImport(a, plan, initialRunState(plan), progress);
    expect(a.calls).toEqual(['units:25', 'units:5', 'balances:1']);
    expect(a.funds).toHaveBeenCalledWith('imp_1', { cash: '5000.00' });
    expect(a.start).toHaveBeenCalledWith({ importId: 'imp_1', asOfDate: '2026-10-31', fileName: 'v.xlsx', totals: { units: 30, people: 0, balances: 1 } });
    expect(s).toMatchObject({ cursor: 3, processedRows: 31, totalRows: 31, job });
    expect(summarize(s).bySheet.units).toEqual({ created: 29, exists: 0, error: 1 });
    expect(summarize(s).errors).toEqual([{ sheet: 'units', row: 3, label: 'x', message: 'm' }]);
  });

  it('hata sonrasi kaldigi parcadan devam eder', async () => {
    const a = api(1);
    let last = initialRunState(plan);
    await expect(runImport(a, plan, last, (s) => (last = s))).rejects.toThrow('ag');
    expect(last.cursor).toBe(1);
    const s = await runImport(a, plan, last, (x) => (last = x));
    expect(a.calls).toEqual(['units:25', 'units:5', 'balances:1']);
    expect(s.processedRows).toBe(31);
    expect(a.funds).toHaveBeenCalledTimes(1);
  });

  it('kurus metni', () => {
    expect(kurusToApiText(1250075)).toBe('12500.75');
    expect(kurusToApiText(5)).toBe('0.05');
  });
});
