import { describe, expect, it } from 'vitest';
import { bankLineSchema, closedAccountFrom, sampleRowsFrom, type MatchTarget, type Suggestion, uploadContentType } from '@/lib/api/bank';
import { ApiError } from '@/lib/api/errors';
import { myPaymentReferenceSchema } from '@/lib/api/portal';
import {
  allocationState,
  canQuickConfirm,
  confidenceBadge,
  fillRemaining,
  filterTargets,
  groupIban,
  previewCounts,
  previewNeedsAck,
  rowsFromSuggestion,
} from './allocation';

const suggestion = (over: Partial<Suggestion> = {}): Suggestion => ({
  kind: 'unit',
  confidence: 0.92,
  reasons: ['Açıklamada blok/daire: A-12'],
  allocations: [{ accountId: 'recv-u12-occupant', unitId: 'u12', liableParty: 'occupant', amount: 150000, unitLabel: 'A Blok · 12', partyLabel: 'Sakin', former: false }],
  ...over,
});

describe('dagitim formu', () => {
  it('toplam satir tutarina esit olmali; en fazla 10 cari; tekrar yok', () => {
    expect(allocationState(150000, [{ accountId: 'a', amount: '1.500,00' }])).toMatchObject({ valid: true, total: 150000, remaining: 0, allocations: [{ accountId: 'a', amount: 150000 }] });
    expect(allocationState(150000, [{ accountId: 'a', amount: '1000' }])).toMatchObject({ valid: false, remaining: 50000, error: 'Dağıtılmamış tutar var' });
    expect(allocationState(150000, [{ accountId: 'a', amount: '2000' }]).error).toBe('Dağıtım satır tutarını aşıyor');
    expect(allocationState(100, [{ accountId: '', amount: '1' }]).error).toBe('Her satır için cari seçin');
    expect(allocationState(200, [{ accountId: 'a', amount: '1' }, { accountId: 'a', amount: '1' }]).error).toBe('Aynı cari iki kez seçilemez');
    expect(allocationState(100, [{ accountId: 'a', amount: 'abc' }]).error).toMatch(/geçerli/);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ accountId: `a${i}`, amount: '0,01' }));
    expect(allocationState(11, eleven).error).toBe('En fazla 10 cariye bölünebilir');
    expect(allocationState(100, []).error).toBe('En az bir cari seçin');
  });

  it('kalan tutar son satira eklenir; oneriden satirlar', () => {
    expect(fillRemaining(350050, [{ accountId: 'a', amount: '1.500,00' }, { accountId: 'b', amount: '' }])).toEqual([
      { accountId: 'a', amount: '1.500,00' },
      { accountId: 'b', amount: '2000,50' },
    ]);
    expect(rowsFromSuggestion(suggestion())).toEqual([{ accountId: 'recv-u12-occupant', amount: '1500,00' }]);
    expect(rowsFromSuggestion(undefined)).toEqual([]);
  });

  it('guven rozeti ve tek tik onay esigi', () => {
    expect(confidenceBadge(1)).toEqual({ tone: 'success', label: 'Kesin (referans kodu)' });
    expect(confidenceBadge(0.92)).toEqual({ tone: 'success', label: 'Çok güçlü %92' });
    expect(confidenceBadge(0.6).tone).toBe('accent');
    expect(confidenceBadge(0.45).tone).toBe('warning');
    expect(canQuickConfirm(suggestion({ confidence: 0.6 }))).toBe(true);
    expect(canQuickConfirm(suggestion({ confidence: 0.47 }))).toBe(false);
    expect(canQuickConfirm(undefined)).toBe(false);
  });

  it('cari arama Turkce karakterden bagimsiz: daire, ad, referans kodu', () => {
    const t = (over: Partial<MatchTarget>): MatchTarget => ({
      accountId: 'x',
      unitId: 'u',
      unitLabel: 'A Blok · 12',
      liableParty: 'occupant',
      partyLabel: 'Sakin',
      former: false,
      holderNames: [],
      openBalance: 0,
      ...over,
    });
    const list = [t({ accountId: 'a', holderNames: ['Şükrü Çelik'] }), t({ accountId: 'b', unitLabel: 'B Blok · 3', refCode: 'K7M2QA' }), t({ accountId: 'c', unitLabel: 'Villa 7' })];
    expect(filterTargets(list, 'sukru').map((x) => x.accountId)).toEqual(['a']);
    expect(filterTargets(list, 'ÇELİK').map((x) => x.accountId)).toEqual(['a']);
    expect(filterTargets(list, 'b blok 3').map((x) => x.accountId)).toEqual(['b']);
    expect(filterTargets(list, 'k7m2qa').map((x) => x.accountId)).toEqual(['b']);
    expect(filterTargets(list, 'villa').map((x) => x.accountId)).toEqual(['c']);
    expect(filterTargets(list, '')).toHaveLength(3);
  });
});

describe('ekstre onizleme', () => {
  it('uyari varsa onay gerekir; sayimlar', () => {
    expect(previewNeedsAck({ warnings: [] })).toBe(false);
    expect(previewNeedsAck({ warnings: ['1 satır okunamadı'] })).toBe(true);
    const l = (flags: string[]) => ({ lineId: 'x', sourceRow: 1, date: '2026-11-01', direction: 'in' as const, amount: 1, description: '', flags: flags as never });
    expect(previewCounts({ lines: [l([]), l(['weak_fingerprint']), l(['duplicate_existing']), l(['duplicate_in_file'])], errors: [{ row: 3, field: 'date', message: 'x' }] })).toEqual({
      fresh: 2,
      existing: 1,
      duplicate: 1,
      errors: 1,
    });
  });

  it('yukleme turu uzantidan tamamlanir (imzali URL ayni turu bekler)', () => {
    expect(uploadContentType({ name: 'kasim.XLSX', type: '' })).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(uploadContentType({ name: 'ekstre.xls', type: 'application/x-msexcel' })).toBe('application/vnd.ms-excel');
    expect(uploadContentType({ name: 'a.csv', type: 'text/csv' })).toBe('text/csv');
    expect(uploadContentType({ name: 'a.bin', type: '' })).toBe('application/octet-stream');
  });

  it('baslik taninmadi hatasindan ornek satirlar; kapali cari hatasindan ayrilan cariler', () => {
    expect(sampleRowsFrom(new ApiError(422, { error: 'unprocessable', sampleRows: [['Gün', 'Not'], ['01.11.2026', 'AIDAT']] }))).toEqual([
      ['Gün', 'Not'],
      ['01.11.2026', 'AIDAT'],
    ]);
    expect(sampleRowsFrom(new ApiError(409, { error: 'conflict' }))).toBeNull();
    const closed = closedAccountFrom(
      new ApiError(409, { error: 'account_closed', accountId: 'recv-u3-occupant', closedThrough: '2026-11-10', formerAccounts: [{ accountId: 'recv-u3-occupant-cX', name: 'Ayrılan sakin', balance: 200050 }] }),
    );
    expect(closed).toEqual({ accountId: 'recv-u3-occupant', closedThrough: '2026-11-10', formerAccounts: [{ accountId: 'recv-u3-occupant-cX', name: 'Ayrılan sakin', balance: 200050 }] });
    expect(closedAccountFrom(new ApiError(409, { error: 'version_conflict' }))).toBeNull();
  });
});

describe('sema ve gosterim', () => {
  it('kuyruk satiri (oneriyle) ve havale bilgisi ayristirilir', () => {
    const line = bankLineSchema.parse({
      lineId: '20261104_aaaaaaaaaaaaaaaaaaaaaaaa',
      bankAccountId: 'bank',
      statementId: 's',
      sourceRow: 5,
      date: '2026-11-04',
      direction: 'in',
      amount: 150000,
      description: 'HAVALE',
      status: 'unmatched',
      version: 1,
      fingerprint: 'yok sayilir',
      suggestion: suggestion(),
    });
    expect(line.suggestion?.allocations[0]?.unitLabel).toBe('A Blok · 12');
    expect(myPaymentReferenceSchema.parse({ unitId: 'u12', unitLabel: 'A Blok · 12', bank: null, references: [] }).bank).toBeNull();
  });

  it('IBAN 4lu gruplanir', () => {
    expect(groupIban('TR330006100519786457841326')).toBe('TR33 0006 1005 1978 6457 8413 26');
  });
});
