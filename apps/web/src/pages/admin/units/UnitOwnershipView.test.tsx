// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transferSchema, unitOwnershipSchema } from '@/lib/api/ownership';
import { UnitOwnershipView } from './UnitOwnershipDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const third = { numerator: 1, denominator: 3 };
const twoThirds = { numerator: 2, denominator: 3 };

const ownershipData = unitOwnershipSchema.parse({
  unitId: 'u1',
  asOf: '2026-11-22',
  registered: true,
  billing: 'joint',
  version: 3,
  current: {
    source: 'register',
    validFrom: '2026-01-01',
    seq: 2,
    owners: [
      { userId: 'a', share: third, bps: 3333 },
      { userId: 'b', share: twoThirds, bps: 6667 },
    ],
  },
  history: [
    { seq: 2, validFrom: '2026-06-01', source: 'transfer', transferId: 't1', reason: 'satış', createdAt: '2026-06-01T09:00:00Z', createdBy: 'm', owners: [] },
    { seq: 1, validFrom: '2026-01-01', source: 'backfill', reason: 'ilk', createdAt: '2026-01-01T09:00:00Z', createdBy: 'm', owners: [] },
  ],
  warnings: ['temsilci yok'],
});

const transfer = transferSchema.parse({
  transferId: 't1',
  unitId: 'u1',
  kind: 'share_partial',
  effectiveDate: '2026-06-01',
  moves: [{ fromUserId: 'b', toUserId: 'a', share: { numerator: 1, denominator: 6 } }],
  before: [],
  after: [],
  billing: 'joint',
  recordSeq: 2,
  debtTo: 'former',
  closures: [],
  membershipChanges: [],
  status: 'completed',
  reason: 'Hisse satışı',
  createdAt: '2026-06-01T09:00:00Z',
  createdBy: 'm',
});

const setBilling = vi.fn();
const setRep = vi.fn();
let canWrite = true;
const mutation = (fn: ReturnType<typeof vi.fn>) => ({ mutateAsync: fn, isPending: false, isError: false, error: null, reset: vi.fn() });

vi.mock('@/hooks/useOwnership', () => ({
  useOwnershipPermissions: () => ({ canRead: true, canWrite }),
  useUnitOwnership: () => ({ data: ownershipData, isPending: false, isError: false, error: null }),
  useUnitTransfers: () => ({ data: [transfer], isPending: false }),
  useSetBilling: () => mutation(setBilling),
  useSetRepresentative: () => mutation(setRep),
  useReverseTransfer: () => mutation(vi.fn()),
  useCreateTransfer: () => mutation(vi.fn()),
  useTransferPreview: () => ({ data: undefined, isPending: true, isError: false, error: null }),
}));
vi.mock('../finance/RegisterSharesDialog', () => ({ RegisterSharesDialog: () => null }));

const names = new Map([
  ['a', 'Ayşe Yılmaz'],
  ['b', 'Bora Kaya'],
]);

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  setBilling.mockReset();
  setRep.mockReset();
  canWrite = true;
});

const button = (text: string) => {
  const b = [...container.querySelectorAll('button')].find((x) => x.textContent?.includes(text));
  if (!b) throw new Error(`dugme yok: ${text}`);
  return b;
};
const click = async (el: Element) => act(async () => (el as HTMLElement).click());
const type = async (el: HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

async function renderView() {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () => createRoot(container).render(<UnitOwnershipView unitId="u1" unitLabel="A / 5" names={names} people={[]} />));
}

describe('Mulkiyet sekmesi', () => {
  it('paydaslar kesir ve yuzde ile, toplam gostergesi, temsilci uyarisi ve gecmis', async () => {
    await renderView();
    const text = container.textContent ?? '';
    expect(text).toContain('Ayşe Yılmaz');
    expect(text).toContain('1/3');
    expect(text).toContain('%33,33');
    expect(text).toContain('%66,67');
    expect(text).toContain('Toplam');
    expect(text).toContain('Tam');
    expect(text).toContain('Ortak cari');
    expect(text).toContain('temsilci yok');
    expect(text).toContain('Mülkiyet geçmişi');
    expect(text).toContain('İlk sicil');
    expect(text).toContain('Kısmi hisse devri');
    expect(button('Geri al')).toBeTruthy();
  });

  it('faturalama modu gerekce ile kaydedilir; temsilci secilir', async () => {
    setBilling.mockResolvedValue(ownershipData);
    setRep.mockResolvedValue(ownershipData);
    await renderView();
    const split = [...container.querySelectorAll<HTMLInputElement>('input[name="billing"]')][1] as HTMLInputElement;
    await click(split);
    await click(button('Modu kaydet'));
    expect(setBilling).not.toHaveBeenCalled();
    await type(container.querySelector('textarea') as HTMLTextAreaElement, 'Paydaşlar ayrı ödeyecek');
    await click(button('Modu kaydet'));
    expect(setBilling).toHaveBeenCalledWith({ unitId: 'u1', mode: 'split', reason: 'Paydaşlar ayrı ödeyecek', version: 3 });

    const rep = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      rep.value = 'b';
      rep.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(button('Temsilciyi kaydet'));
    expect(setRep).toHaveBeenCalledWith({ unitId: 'u1', userId: 'b', version: 3 });
  });

  it('devir sihirbazi acilir; salt okunur rolde yazma dugmeleri yok', async () => {
    await renderView();
    await click(button('Mülk / hisse devri'));
    expect(container.textContent).toContain('Devir türü');
    container.remove();

    canWrite = false;
    await renderView();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Mülk / hisse devri'))).toBe(false);
    expect(container.querySelector('input[name="billing"]')).toBeNull();
    expect(container.textContent).toContain('temsilci yok');
  });
});
