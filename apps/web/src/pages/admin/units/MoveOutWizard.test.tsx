// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closurePreviewSchema } from '@/lib/api/closures';
import { MoveOutWizard } from './MoveOutWizard';
import type { UnitRow } from './unitRows';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const previewData = closurePreviewSchema.parse({
  unitId: 'u1',
  party: 'occupant',
  moveOutDate: '2026-11-15',
  sourceAccountId: 'recv-u1-occupant',
  lateFeeMonthlyBasisPoints: 500,
  lateFee: 0,
  net: 160000,
  debt: 160000,
  advance: 0,
  items: [{ sourceChargeId: 'tx1', category: 'principal', description: 'Ekim aidatı', date: '2026-10-01', dueDate: '2026-10-10', amount: 160000 }],
  later: { charges: 0, credits: 0, creditAmount: 0 },
  memberships: [{ userId: 'kiraci-1', relation: 'tenant', residesInUnit: true, startDate: '2025-01-01', change: 'ended' }],
  incomingOwners: [],
  targets: { debt: ['former', 'owner'], advance: ['refund', 'former', 'owner'] },
  warnings: ['Dikkat: örnek uyarı'],
});

const mutateAsync = vi.fn();
const previewCalls: unknown[] = [];

vi.mock('@/hooks/useClosures', () => ({
  useClosurePreview: (_unitId: string, q: unknown) => {
    previewCalls.push(q);
    return { data: q ? previewData : undefined, isPending: !q, isError: false, error: null };
  },
  useCreateClosure: () => ({ mutateAsync, isPending: false, isError: false, error: null }),
}));
vi.mock('@/hooks/useFinance', () => ({
  useFinanceAccounts: () => ({ data: [], isPending: false }),
}));

const row = {
  unit: { unitId: 'u1', number: '1' },
  blockName: 'A',
  owners: [{ userId: 'malik', name: 'Malik' }],
  tenants: [{ userId: 'kiraci-1', name: 'Kiracı Bir' }],
  occupancy: 'occupied',
} as unknown as UnitRow;

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  mutateAsync.mockReset();
  previewCalls.length = 0;
});

const button = (text: string) => {
  const b = [...container.querySelectorAll('button')].find((x) => x.textContent?.includes(text));
  if (!b) throw new Error(`dugme yok: ${text}`);
  return b;
};
const click = async (el: Element) => act(async () => (el as HTMLElement).click());
const type = async (el: HTMLTextAreaElement | HTMLInputElement, value: string) =>
  act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('MoveOutWizard', () => {
  it('kim/tarih -> onizleme -> karar -> onay akisi tek atomik istek gonderir', async () => {
    mutateAsync.mockResolvedValue({
      replayed: false,
      closure: { ...previewData, closureId: 'c1', userIds: ['kiraci-1'], debtTo: 'owner', advanceTo: 'former', membershipChanges: [], status: 'completed', reason: 'Kiracı taşındı', createdAt: '2026-11-15T10:00:00Z', createdBy: 'm' },
    });
    const onInvite = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    await act(async () =>
      createRoot(container).render(
        <MemoryRouter>
          <MoveOutWizard row={row} names={new Map([['kiraci-1', 'Kiracı Bir']])} onCancel={() => {}} onDone={() => {}} onInvite={onInvite} />
        </MemoryRouter>,
      ),
    );

    // 1. Kim / tarih: kiraci varken sakin carisi on secili; tarih girilir.
    const date = container.querySelector<HTMLInputElement>('input[type="date"]');
    expect(date).not.toBeNull();
    await type(date as HTMLInputElement, '2026-11-15');
    await click(button('Önizle'));
    expect(previewCalls.at(-1)).toEqual({ party: 'occupant', moveOutDate: '2026-11-15' });

    // 2. Onizleme: tutarlar, kalem, uyelik degisikligi ve uyarı
    expect(container.textContent).toContain('Ekim aidatı');
    expect(container.textContent).toContain('Kiracı Bir');
    expect(container.textContent).toContain('Dikkat: örnek uyarı');
    await click(button('Devam'));

    // 3. Karar: varsayilan ayrilan carisi; malik carisine devret secilir.
    const ownerRadio = [...container.querySelectorAll<HTMLInputElement>('input[name="debtTo"]')][1];
    expect(container.querySelectorAll<HTMLInputElement>('input[name="debtTo"]')[0]?.checked).toBe(true);
    await click(ownerRadio as HTMLInputElement);
    await click(button('Devam'));

    // 4. Onay: gerekce olmadan gonderilmez.
    await click(button('Cariyi kapat'));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Gerekçe en az 5 karakter');
    await type(container.querySelector('textarea') as HTMLTextAreaElement, 'Kiracı taşındı');
    await click(button('Cariyi kapat'));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    const { unitId, input } = mutateAsync.mock.calls[0]?.[0] as { unitId: string; input: Record<string, unknown> };
    expect(unitId).toBe('u1');
    expect(input).toMatchObject({ party: 'occupant', moveOutDate: '2026-11-15', userIds: ['kiraci-1'], debtTo: 'owner', advanceTo: 'former', reason: 'Kiracı taşındı' });
    expect(String(input.idempotencyKey).length).toBeGreaterThanOrEqual(8);

    // Sonuc: yeni sakin davet baglantisi
    expect(container.textContent).toContain('kapatıldı');
    await click(button('Yeni sakin davet et'));
    expect(onInvite).toHaveBeenCalledTimes(1);
  });
});
