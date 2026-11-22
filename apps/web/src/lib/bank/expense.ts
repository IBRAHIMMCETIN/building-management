import type { BankLine } from '@/lib/api/bank';
import type { FinanceAccount } from '@/lib/api/finance';

/*
 * Faz B3 - Bankadan cikan satiri gidere cevirme (saf yardimcilar).
 */

const fold = (s: string) =>
  s
    .toLocaleUpperCase('tr-TR')
    .replace(/[ÇĞİÖŞÜ]/g, (c) => ({ Ç: 'C', Ğ: 'G', İ: 'I', Ö: 'O', Ş: 'S', Ü: 'U' })[c] ?? c)
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

/**
 * Aciklamadaki anahtar kelimeye gore varsayilan gider kalemi (API'nin varsayilan gider hesaplari:
 * exp-electricity, exp-water ...). Kural sirasi onemlidir: ilk eslesen kazanir.
 */
const RULES: readonly { accountId: string; words: readonly string[] }[] = [
  { accountId: 'exp-electricity', words: ['ELEKTRIK', 'ENERJISA', 'CK ENERJI', 'AYEDAS', 'BEDAS', 'TOROSLAR', 'UEDAS', 'BASKENT EDAS'] },
  { accountId: 'exp-water', words: ['ISKI', 'ASKI', 'IZSU', 'BUSKI', 'SU FATURA', 'SU BEDELI'] },
  { accountId: 'exp-heating', words: ['DOGALGAZ', 'DOGAL GAZ', 'IGDAS', 'BASKENTGAZ', 'IZMIRGAZ', 'AKSAGAZ'] },
  { accountId: 'exp-elevator', words: ['ASANSOR'] },
  { accountId: 'exp-cleaning', words: ['TEMIZLIK'] },
  { accountId: 'exp-security', words: ['GUVENLIK'] },
  { accountId: 'exp-garden', words: ['BAHCE', 'PEYZAJ'] },
  { accountId: 'exp-staff', words: ['MAAS', 'KAPICI', 'SGK', 'PERSONEL'] },
  { accountId: 'exp-repair', words: ['TAMIR', 'ONARIM', 'BAKIM', 'TESISAT'] },
  { accountId: 'exp-management', words: ['YONETIM', 'MUHASEBE', 'NOTER'] },
  { accountId: 'exp-other', words: ['MASRAF', 'KOMISYON', 'UCRET', 'EFT UCRET', 'HAVALE UCRET', 'HESAP ISLETIM', 'BSMV'] },
];

/** Oneri yalnizca aktif gider hesaplari arasindan; bulunamazsa ilk aktif gider hesabi (yoksa ''). */
export function guessExpenseAccount(description: string, accounts: readonly Pick<FinanceAccount, 'accountId' | 'type' | 'status'>[]): string {
  const usable = accounts.filter((a) => a.type === 'expense' && a.status === 'active');
  const text = ` ${fold(description)} `;
  for (const rule of RULES) {
    if (!usable.some((a) => a.accountId === rule.accountId)) continue;
    if (rule.words.some((w) => text.includes(` ${w}`))) return rule.accountId;
  }
  return usable[0]?.accountId ?? '';
}

export type ExpenseForm = { expenseAccountId: string; description: string; supplier: string; invoiceNumber: string };

/** Diyalogun ilk degerleri: banka aciklamasi ve karsi taraf adi. */
export function expenseDefaults(line: Pick<BankLine, 'description' | 'counterpartyName'>, accounts: readonly Pick<FinanceAccount, 'accountId' | 'type' | 'status'>[]): ExpenseForm {
  return {
    expenseAccountId: guessExpenseAccount(`${line.description} ${line.counterpartyName ?? ''}`, accounts),
    description: line.description.replace(/\s+/g, ' ').trim().slice(0, 200),
    supplier: (line.counterpartyName ?? '').slice(0, 120),
    invoiceNumber: '',
  };
}

/** Form dogrulamasi (API ile ayni sinirlar); gecerliyse istek govdesi. */
export function expenseFormState(form: ExpenseForm): { valid: boolean; error?: string; input?: { expenseAccountId: string; description: string; supplier?: string; invoiceNumber?: string } } {
  const description = form.description.replace(/\s+/g, ' ').trim();
  if (!form.expenseAccountId) return { valid: false, error: 'Gider kalemi seçin' };
  if (description.length < 2 || description.length > 200) return { valid: false, error: 'Açıklama 2-200 karakter olmalı' };
  if (form.supplier.trim().length > 120) return { valid: false, error: 'Tedarikçi en fazla 120 karakter olabilir' };
  if (form.invoiceNumber.trim().length > 60) return { valid: false, error: 'Fatura no en fazla 60 karakter olabilir' };
  return {
    valid: true,
    input: {
      expenseAccountId: form.expenseAccountId,
      description,
      ...(form.supplier.trim() ? { supplier: form.supplier.trim() } : {}),
      ...(form.invoiceNumber.trim() ? { invoiceNumber: form.invoiceNumber.trim() } : {}),
    },
  };
}
