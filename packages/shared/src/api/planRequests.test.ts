import { describe, expect, it } from 'vitest';
import { PLAN_REQUEST_STATUSES, PLAN_REQUEST_STATUS_LABELS, installmentChoices, monthlyAmount, myPlanRequestSchema, planRequestOptionsSchema, splitInstallments } from './planRequests';

describe('yapilandirma talebi (ortak)', () => {
  it('kurus kaybi olmadan esit bolme', () => {
    expect(splitInstallments(310001, 3)).toEqual([103334, 103334, 103333]);
    expect(splitInstallments(310001, 3).reduce((a, b) => a + b, 0)).toBe(310001);
    expect(splitInstallments(100, 0)).toEqual([]);
    expect(monthlyAmount(310001, 3)).toBe(103334);
  });

  it('secilebilir taksitler 2..cari siniri; sinir 2 altindaysa bos', () => {
    expect(installmentChoices({ maxInstallments: 4 })).toEqual([2, 3, 4]);
    expect(installmentChoices({ maxInstallments: 1 })).toEqual([]);
  });

  it('semalar API yanitini dogrular; her durumun etiketi var', () => {
    const opt = planRequestOptionsSchema.parse({
      unitId: 'u1',
      settings: { enabled: true, maxInstallments: 6, minInstallmentAmount: 50000, includeLateFees: true },
      minInstallments: 2,
      accounts: [{ accountId: 'recv-u1-occupant', liableParty: 'occupant', overdue: 300000, accruedLateFee: 1200, total: 301200, maxInstallments: 6, eligible: true }],
    });
    expect(opt.accounts[0]?.eligible).toBe(true);
    expect(() =>
      myPlanRequestSchema.parse({ requestId: 'r', unitId: 'u', accountId: 'a', liableParty: 'owner', installments: 3, estimate: { overdue: 1, accruedLateFee: 0, total: 1, installmentAmount: 0 }, status: 'bilinmeyen', createdAt: 'x', updatedAt: 'x' }),
    ).toThrow();
    for (const s of PLAN_REQUEST_STATUSES) expect(PLAN_REQUEST_STATUS_LABELS[s]).toBeTruthy();
  });
});
