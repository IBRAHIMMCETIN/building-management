import { describe, expect, it } from 'vitest';
import {
  bpsToPercent,
  formatConsumption,
  formatIndex,
  formatPercentChange,
  isLegalDeviation,
  parseImportTable,
  parseIndexText,
  percentToBps,
  photoFileError,
  splitLabel,
} from './model';

describe('endeks metni (API parseIndexText ile ayni kurallar)', () => {
  it('Turkce bicim, ondalik ve binlik ayirici', () => {
    expect(parseIndexText('1.234,567', 3)).toEqual({ ok: true, value: 1234567 });
    expect(parseIndexText('1234,5', 3)).toEqual({ ok: true, value: 1234500 });
    expect(parseIndexText('1234.5', 3)).toEqual({ ok: true, value: 1234500 });
    expect(parseIndexText('1.234', 0)).toEqual({ ok: true, value: 1234 });
    expect(parseIndexText(' 0042 ', 0)).toEqual({ ok: true, value: 42 });
  });

  it('gecersiz metin ve fazla ondalik reddedilir (yuvarlama yok)', () => {
    expect(parseIndexText('', 0).ok).toBe(false);
    expect(parseIndexText('12a', 0).ok).toBe(false);
    expect(parseIndexText('1,2345', 3)).toMatchObject({ ok: false, message: expect.stringContaining('3 ondalık') });
    expect(parseIndexText('1,5', 0)).toMatchObject({ ok: false });
    expect(parseIndexText('1,234.5', 3).ok).toBe(false);
    expect(parseIndexText('12.34.56', 3).ok).toBe(false);
  });

  it('olcekli endeks gosterimi', () => {
    expect(formatIndex(1234567, 3)).toBe('1.234,567');
    expect(formatIndex(5, 3)).toBe('0,005');
    expect(formatIndex(1234567, 0)).toBe('1.234.567');
    expect(formatIndex(0, 0)).toBe('0');
    // gidis-donus
    for (const [v, s] of [[987654321, 2], [10, 1], [0, 6]] as const) {
      expect(parseIndexText(formatIndex(v, s), s)).toEqual({ ok: true, value: v });
    }
  });

  it('tuketim ve yuzde bicimi', () => {
    expect(formatConsumption('1234.5')).toBe('1.234,5');
    expect(formatConsumption('1234,500')).toBe('1.234,5');
    expect(formatPercentChange(12.34)).toBe('+%12,3');
    expect(formatPercentChange(-5)).toBe('-%5');
    expect(formatPercentChange(0)).toBe('%0');
  });
});

describe('yonetmelik sapmasi (karar 2) ve oran', () => {
  it('merkezi isitmada yalnizca %30 + kullanim alani yonetmeliğe uygundur', () => {
    expect(isLegalDeviation({ legalProfile: 'central_heating', commonShareBps: 3000, commonKey: 'area' })).toBe(false);
    expect(isLegalDeviation({ legalProfile: 'central_heating', commonShareBps: 4000, commonKey: 'area' })).toBe(true);
    expect(isLegalDeviation({ legalProfile: 'central_heating', commonShareBps: 3000, commonKey: 'equal' })).toBe(true);
    expect(isLegalDeviation({ legalProfile: 'none', commonShareBps: 0, commonKey: 'area' })).toBe(false);
    expect(isLegalDeviation({ legalProfile: 'district_heating', commonShareBps: 5000, commonKey: 'land_share' })).toBe(false);
  });

  it('yuzde <-> baz puan', () => {
    expect(percentToBps('30')).toBe(3000);
    expect(percentToBps('30,5')).toBe(3050);
    expect(percentToBps('0')).toBe(0);
    expect(percentToBps('100')).toBe(10000);
    expect(percentToBps('101')).toBeNull();
    expect(percentToBps('-5')).toBeNull();
    expect(percentToBps('abc')).toBeNull();
    expect(bpsToPercent(3050)).toBe('30,5');
    expect(splitLabel(3000, 'area')).toBe('%30 ortak (Kullanım alanı (m²)) + %70 tüketim');
    expect(splitLabel(0, 'area')).toBe('%100 tüketim');
  });
});

describe('toplu endeks aktarimi tablosu', () => {
  it('basliktan sutunlari bulur, bos satirlari atlar, gercek satir numarasini korur', () => {
    const r = parseImportTable([
      ['Sayaç', 'Daire', 'Sayaç adı', 'Başlangıç endeksi', 'Endeks', 'Not'],
      ['PO-1', '1', 'Salon', '100', '1.234,5', ''],
      ['', '', '', '', '', ''],
      ['PO-2', '2', 'Salon', '0', 250, 'kapı kapalıydı'],
    ]);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { row: 2, meter: 'PO-1', index: '1.234,5' },
      { row: 4, meter: 'PO-2', index: '250', note: 'kapı kapalıydı' },
    ]);
  });

  it('basliksiz dosyada sira: sayac, endeks, not; Excel ondalik sayisi virgule cevrilir', () => {
    const r = parseImportTable([['PO-1', 12.5], ['PO-2', '7']]);
    expect(r.rows).toEqual([
      { row: 1, meter: 'PO-1', index: '12,5' },
      { row: 2, meter: 'PO-2', index: '7' },
    ]);
  });

  it('sayaci bos satir hata; bos dosya hata', () => {
    expect(parseImportTable([['Seri No', 'Endeks'], ['', '5']]).errors).toEqual(['Satır 2: sayaç (seri no) boş', ]);
    expect(parseImportTable([]).errors).toEqual(['Dosyada satır yok.']);
  });
});

describe('fotograf dosyasi', () => {
  it('tur ve boyut', () => {
    expect(photoFileError({ type: 'image/jpeg', size: 1000 })).toBeNull();
    expect(photoFileError({ type: 'image/heic', size: 1000 })).toBeNull();
    expect(photoFileError({ type: 'application/pdf', size: 1000 })).toMatch(/JPEG/);
    expect(photoFileError({ type: 'image/png', size: 11 * 1024 * 1024 })).toMatch(/10 MB/);
  });
});
