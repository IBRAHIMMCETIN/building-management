import { describe, expect, it } from 'vitest';
import { actionLabel, findingLabel } from '@/lib/audit/labels';
import {
  DEFAULT_RULE,
  addMonths,
  defaultFirstDueDate,
  installmentSummary,
  offsetFormState,
  planDraftErrors,
  ruleErrors,
  ruleText,
  splitEven,
} from './model';

const ITEMS = [
  { chargeId: 'c1', description: 'Eylül', dueDate: '2026-09-10', remaining: 50000, overdue: true },
  { chargeId: 'c2', description: 'Ekim', dueDate: '2026-10-10', remaining: 50000, overdue: true },
];
const base = { amount: 30000, maxAmount: 60000, selected: [], items: ITEMS, consentRequired: false, consent: false, consentNote: '', reason: 'Avans aidata' };

describe('avans mahsubu formu', () => {
  it('gecerli tutar; serbest avans / acik borc siniri', () => {
    expect(offsetFormState(base)).toEqual({ valid: true, amount: 30000, errors: {} });
    expect(offsetFormState({ ...base, amount: 60001 }).errors.amount).toContain('Tutar en fazla');
    expect(offsetFormState({ ...base, amount: null }).errors.amount).toBe('Geçerli bir tutar girin');
    expect(offsetFormState({ ...base, maxAmount: 0 }).errors.amount).toContain('serbest avans');
    expect(offsetFormState({ ...base, reason: 'kısa' }).errors.reason).toBeDefined();
  });

  it('kalem secimi: tutar secilen kalemlerin kalanidir ve hedefli mahsup olarak gider', () => {
    const s = offsetFormState({ ...base, amount: null, selected: ['c2'] });
    expect(s).toMatchObject({ valid: true, amount: 50000, settles: [{ chargeId: 'c2', amount: 50000 }] });
    expect(offsetFormState({ ...base, selected: ['c1', 'c2'] }).errors.amount).toContain('Tutar en fazla');
  });

  it('farkli kisiler: muvafakat beyani ve aciklama zorunlu', () => {
    const d = { ...base, consentRequired: true };
    expect(offsetFormState(d).errors.consent).toContain('muvafakat beyanı');
    expect(offsetFormState({ ...d, consent: true, consentNote: 'ok' }).errors.consent).toContain('en az 5');
    expect(offsetFormState({ ...d, consent: true, consentNote: 'Yazılı onay alındı' }).valid).toBe(true);
  });
});

describe('borc yapilandirma kurallari', () => {
  it('esit bolme ve aylik vadeler API ile ayni', () => {
    expect(splitEven(213667, 4)).toEqual([53417, 53417, 53417, 53416]);
    expect(splitEven(100, 0)).toEqual([]);
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-30', 2)).toBe('2027-01-30');
    expect(defaultFirstDueDate('2026-11-05')).toBe('2026-12-05');
  });

  it('taksit adimi: kalem, 1-60 taksit, ilk vade bugun..12 ay, esikler', () => {
    const ok = { selected: ['c1'], installments: 6, firstDueDate: '2026-12-10', today: '2026-11-05', rule: DEFAULT_RULE };
    expect(planDraftErrors(ok)).toEqual({});
    expect(planDraftErrors({ ...ok, selected: [] }).selected).toBeDefined();
    expect(planDraftErrors({ ...ok, installments: 61 }).installments).toBeDefined();
    expect(planDraftErrors({ ...ok, installments: 0 }).installments).toBeDefined();
    expect(planDraftErrors({ ...ok, firstDueDate: '2026-11-01' }).firstDueDate).toContain('bugünden önce');
    expect(planDraftErrors({ ...ok, firstDueDate: '2027-11-06' }).firstDueDate).toContain('12 ay');
    expect(planDraftErrors({ ...ok, firstDueDate: '' }).firstDueDate).toBeDefined();
    expect(planDraftErrors({ ...ok, rule: { ...DEFAULT_RULE, consecutive: 4 } }).rule).toBeDefined();
  });

  it('muacceliyet esikleri', () => {
    expect(ruleErrors(DEFAULT_RULE)).toEqual({});
    expect(ruleErrors({ ...DEFAULT_RULE, consecutive: 4, total: 3 })).toEqual({ consecutive: 'Toplam eşikten büyük olamaz' });
    expect(ruleErrors({ ...DEFAULT_RULE, graceDays: 91 }).graceDays).toBeDefined();
    expect(ruleErrors({ ...DEFAULT_RULE, total: 0 }).total).toBeDefined();
    expect(ruleText(DEFAULT_RULE)).toContain('2 ardışık veya toplam 3 taksit');
    expect(ruleText(DEFAULT_RULE)).toContain('yönetici onayıyla');
  });

  it('siradaki taksit ve geciken sayisi', () => {
    const s = installmentSummary([
      { no: 1, dueDate: '2026-12-10', remaining: 0, overdue: false },
      { no: 2, dueDate: '2027-01-10', remaining: 100, overdue: true },
      { no: 3, dueDate: '2027-02-10', remaining: 100, overdue: false },
    ]);
    expect(s).toEqual({ next: { no: 2, dueDate: '2027-01-10', remaining: 100, overdue: true }, overdueCount: 1, openCount: 2 });
  });
});

describe('denetim etiketleri (Finans 2.2)', () => {
  it('mahsup / yapilandirma olaylari, defter turleri ve gece denetimi bulgusu', () => {
    expect(actionLabel('finance.offset')).toBe('Avans mahsubu');
    expect(actionLabel('finance.plan_create')).toBe('Borç yapılandırma (taksit planı) oluşturuldu');
    expect(actionLabel('finance.plan_default')).toBe('Taksit planında temerrüt tespit edildi');
    expect(actionLabel('ledger.offset')).toBe('Defter: avans mahsubu');
    expect(actionLabel('ledger.late_fee+restructure')).toBe('Defter: gecikme tazminatı + borç yapılandırma');
    expect(findingLabel('settlement_invalid')).toContain('Hedefli mahsup');
    expect(findingLabel('yeni_kod')).toBe('yeni kod');
  });
});
