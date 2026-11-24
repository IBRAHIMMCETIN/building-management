// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeterPeriod, ReversePreview } from '@/lib/api/meters';
import { ReverseDialog } from './ReverseDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PERIOD: MeterPeriod = {
  periodId: 'p1',
  name: 'Kasım 2026',
  templateId: 't1',
  template: { templateId: 't1', name: 'Merkezi ısıtma', category: 'heating', commonShareBps: 3000, commonKey: 'area', liableParty: 'occupant', legalProfile: 'central_heating' },
  meterKind: 'heat_allocator',
  startDate: '2026-11-01',
  endDate: '2026-11-30',
  dueDate: '2026-12-15',
  totalAmount: 100001,
  expenseIds: [],
  status: 'posted',
  version: 5,
};

let preview: ReversePreview;
const reverse = { isPending: false, isError: false, error: null as unknown, data: undefined, mutateAsync: vi.fn().mockResolvedValue({}), reset: () => {} };

vi.mock('@/hooks/useMeters', () => ({
  useReversePreview: () => ({ isPending: false, isError: false, data: preview }),
  useReversePeriod: () => reverse,
}));

function previewOf(over: Partial<ReversePreview> = {}): ReversePreview {
  return {
    period: PERIOD,
    canReverse: true,
    blockers: [],
    items: [
      { unitId: 'u1', unitNumber: '1', amount: 27500, state: 'reversible' },
      { unitId: 'u2', unitNumber: '2', amount: 72501, state: 'reversible', lateFeeAfter: ['lf-1'] },
    ],
    total: 100001,
    lateFeeWarnings: [{ unitId: 'u2', transactionIds: ['lf-1'] }],
    ...over,
  };
}

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  reverse.mutateAsync.mockClear();
});

function render() {
  container = document.createElement('div');
  document.body.append(container);
  act(() => createRoot(container).render(<ReverseDialog period={PERIOD} unitLabel={(id, fb) => `Daire ${fb ?? id}`} onClose={() => {}} />));
}
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
function setValue(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, value);
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('toplu geri alma penceresi', () => {
  it('varsayilan sessiz: bildirim kutusu isaretsiz gider; gecikme tazminati uyarisi gosterilir', async () => {
    preview = previewOf();
    render();
    expect(document.body.textContent).toContain('gecikme tazminatı işlenmiş');
    const notify = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(notify.checked).toBe(false);

    setValue(document.querySelector('textarea') as HTMLTextAreaElement, 'Hatalı okuma');
    await act(async () => {
      button('Toplu geri al').click();
    });
    expect(reverse.mutateAsync).toHaveBeenCalledTimes(1);
    expect(reverse.mutateAsync.mock.calls[0]?.[0]).toMatchObject({ periodId: 'p1', reason: 'Hatalı okuma', notify: false });
    expect(reverse.mutateAsync.mock.calls[0]?.[0].idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('isaretlenirse bildirim gonderilir; engel varsa dugme kapali', async () => {
    preview = previewOf();
    render();
    act(() => {
      (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    });
    setValue(document.querySelector('textarea') as HTMLTextAreaElement, 'Hatalı okuma');
    await act(async () => {
      button('Toplu geri al').click();
    });
    expect(reverse.mutateAsync.mock.calls[0]?.[0]).toMatchObject({ notify: true });
    container.remove();
    document.body.innerHTML = '';

    preview = previewOf({ canReverse: false, blockers: [{ code: 'newer_period', message: 'Sonraki dönem önce geri alınmalı', unitId: 'u1' }] });
    render();
    expect(document.body.textContent).toContain('Sonraki dönem önce geri alınmalı');
    expect(button('Toplu geri al').disabled).toBe(true);
  });
});
