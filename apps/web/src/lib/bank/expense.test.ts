import { describe, expect, it } from 'vitest';
import { expenseDefaults, expenseFormState, guessExpenseAccount } from './expense';

const acc = (accountId: string, status: 'active' | 'inactive' = 'active') => ({ accountId, type: 'expense' as const, status });
const ACCOUNTS = [acc('exp-cleaning'), acc('exp-elevator'), acc('exp-electricity'), acc('exp-water'), acc('exp-heating'), acc('exp-repair'), acc('exp-other')];

describe('gider kalemi tahmini', () => {
  it('aciklamadaki anahtar kelimeye gore (Turkce karakter duyarsiz)', () => {
    expect(guessExpenseAccount('ENERJİSA FATURA ÖDEMESİ 2026/11', ACCOUNTS)).toBe('exp-electricity');
    expect(guessExpenseAccount('İSKİ su faturası', ACCOUNTS)).toBe('exp-water');
    expect(guessExpenseAccount('İGDAŞ DOĞALGAZ', ACCOUNTS)).toBe('exp-heating');
    expect(guessExpenseAccount('Asansör bakım sözleşmesi', ACCOUNTS)).toBe('exp-elevator');
    expect(guessExpenseAccount('KAZAN TAMİRİ', ACCOUNTS)).toBe('exp-repair');
    expect(guessExpenseAccount('EFT ÜCRETİ + BSMV', ACCOUNTS)).toBe('exp-other');
  });

  it('kelime ortasinda eslesmez; pasif/olmayan hesap onerilmez; bulunamazsa ilk aktif gider', () => {
    // "ASKI" yalnizca kelime basinda: "MASKI..." gibi kelimeler su sayilmaz.
    expect(guessExpenseAccount('MASKIRA LTD', [acc('exp-cleaning'), acc('exp-water')])).toBe('exp-cleaning');
    expect(guessExpenseAccount('ELEKTRIK', [acc('exp-electricity', 'inactive'), acc('exp-cleaning')])).toBe('exp-cleaning');
    expect(guessExpenseAccount('ACIKLAMA YOK', [acc('exp-cleaning')])).toBe('exp-cleaning');
    expect(guessExpenseAccount('ELEKTRIK', [])).toBe('');
    expect(guessExpenseAccount('ELEKTRIK', [{ accountId: 'bank', type: 'bank', status: 'active' }])).toBe('');
  });

  it('varsayilanlar banka satirindan gelir', () => {
    expect(expenseDefaults({ description: '  CK  ENERJİ   fatura ', counterpartyName: 'CK ENERJİ AYEDAŞ' }, ACCOUNTS)).toEqual({
      expenseAccountId: 'exp-electricity',
      description: 'CK ENERJİ fatura',
      supplier: 'CK ENERJİ AYEDAŞ',
      invoiceNumber: '',
    });
  });
});

describe('gider formu', () => {
  const base = { expenseAccountId: 'exp-water', description: 'İSKİ', supplier: '', invoiceNumber: '' };
  it('gecerli form istek govdesine donusur (bos alanlar gonderilmez)', () => {
    expect(expenseFormState(base)).toEqual({ valid: true, input: { expenseAccountId: 'exp-water', description: 'İSKİ' } });
    expect(expenseFormState({ ...base, supplier: ' İSKİ Genel Md. ', invoiceNumber: 'A-123' }).input).toEqual({
      expenseAccountId: 'exp-water',
      description: 'İSKİ',
      supplier: 'İSKİ Genel Md.',
      invoiceNumber: 'A-123',
    });
  });
  it('kalem ve aciklama zorunlu; uzunluk sinirlari', () => {
    expect(expenseFormState({ ...base, expenseAccountId: '' })).toMatchObject({ valid: false, error: 'Gider kalemi seçin' });
    expect(expenseFormState({ ...base, description: ' x ' })).toMatchObject({ valid: false });
    expect(expenseFormState({ ...base, description: 'a'.repeat(201) })).toMatchObject({ valid: false });
    expect(expenseFormState({ ...base, invoiceNumber: '1'.repeat(61) })).toMatchObject({ valid: false });
  });
});
