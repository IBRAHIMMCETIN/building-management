// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transferPreviewSchema } from '@/lib/api/ownership';
import { OwnershipTransferWizard } from './OwnershipTransferWizard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const half = { numerator: 1, denominator: 2 };
const quarter = { numerator: 1, denominator: 4 };

const previewData = transferPreviewSchema.parse({
  unitId: 'u1',
  kind: 'share_partial',
  effectiveDate: '2026-11-01',
  cutoff: '2026-10-31',
  billing: 'split',
  before: [
    { userId: 'a', share: half, bps: 5000 },
    { userId: 'b', share: half, bps: 5000 },
  ],
  after: [
    { userId: 'a', share: quarter, bps: 2500 },
    { userId: 'b', share: half, bps: 5000 },
    { userId: 'c', share: quarter, bps: 2500 },
  ],
  exiting: [],
  entering: ['c'],
  changed: ['a'],
  debtTo: 'former',
  closures: [],
  membershipChanges: [
    { userId: 'a', change: 'share' },
    { userId: 'c', change: 'created' },
  ],
  warnings: ['Kısmi devirde devredenin geçmiş borcu kendi carisinde kalır.'],
});

const mutateAsync = vi.fn();
const previewInputs: unknown[] = [];

vi.mock('@/hooks/useOwnership', () => ({
  useTransferPreview: (_unitId: string, input: unknown) => {
    previewInputs.push(input);
    return { data: input ? previewData : undefined, isPending: !input, isError: false, error: null };
  },
  useCreateTransfer: () => ({ mutateAsync, isPending: false, isError: false, error: null, data: undefined }),
}));

const owners = [
  { userId: 'a', share: half, bps: 5000 },
  { userId: 'b', share: half, bps: 5000 },
];
const people = [
  { userId: 'a', fullName: 'Ayşe Yılmaz' },
  { userId: 'b', fullName: 'Bora Kaya' },
  { userId: 'c', fullName: 'Cem Demir' },
];
const names = new Map(people.map((p) => [p.userId, p.fullName]));

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  mutateAsync.mockReset();
  previewInputs.length = 0;
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
const choose = async (el: HTMLSelectElement, value: string) =>
  act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

async function renderWizard() {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () =>
    createRoot(container).render(
      <OwnershipTransferWizard unitId="u1" unitLabel="A / 5" owners={owners} people={people} names={names} onCancel={() => {}} onDone={() => {}} />,
    ),
  );
}

describe('OwnershipTransferWizard', () => {
  it('kismi devir: hareket -> taslak tablo -> onizleme -> gerekce -> tek istek', async () => {
    mutateAsync.mockResolvedValue({ replayed: false, transfer: { transferId: 't1' }, warnings: [] });
    await renderWizard();

    const [from, to] = [...container.querySelectorAll('select')];
    await choose(from as HTMLSelectElement, 'a');
    await choose(to as HTMLSelectElement, 'c');
    await type(container.querySelector<HTMLInputElement>('input[placeholder="1/4"]') as HTMLInputElement, '1/4');

    // Taslak sonuc tablosu (bps gosterimi).
    expect(container.textContent).toContain('Devirden sonra (taslak)');
    expect(container.textContent).toContain('Cem Demir');
    expect(container.textContent).toContain('%25');
    // Yeni malik icin oturma sorusu.
    expect(container.textContent).toContain('Yeni malikler dairede oturacak mı?');

    await click(button('Önizle'));
    expect(previewInputs.at(-1)).toMatchObject({ kind: 'share_partial', moves: [{ fromUserId: 'a', toUserId: 'c', share: quarter }], debtTo: 'former' });
    expect(container.textContent).toContain('Cari hareketi yok');
    expect(container.textContent).toContain('Yeni malik üyeliği açılır');
    expect(container.textContent).toContain('Kısmi devirde');

    await click(button('Devam'));
    await click(button('Devri kaydet'));
    // Gerekce zorunlu.
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Gerekçe en az 5 karakter');

    await type(container.querySelector('textarea') as HTMLTextAreaElement, 'Tapu satışı 2026');
    await click(button('Devri kaydet'));
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    const arg = mutateAsync.mock.calls[0]?.[0] as { unitId: string; input: Record<string, unknown> };
    expect(arg.unitId).toBe('u1');
    expect(arg.input).toMatchObject({
      kind: 'share_partial',
      moves: [{ fromUserId: 'a', toUserId: 'c', share: quarter }],
      debtTo: 'former',
      reason: 'Tapu satışı 2026',
    });
    expect(typeof arg.input.idempotencyKey).toBe('string');
    expect(container.textContent).toContain('Devir kaydedildi');
  });

  it('gecersiz pay: hata gosterilir, onizleme kapali', async () => {
    await renderWizard();
    const [from, to] = [...container.querySelectorAll('select')];
    await choose(from as HTMLSelectElement, 'a');
    await choose(to as HTMLSelectElement, 'c');
    await type(container.querySelector<HTMLInputElement>('input[placeholder="1/4"]') as HTMLInputElement, '3/4');
    expect(container.textContent).toContain('devredenin payını aşıyor');
    expect(button('Önizle').disabled).toBe(true);
  });

  it('tam satis: alici secilip tum paylara uygulanir', async () => {
    await renderWizard();
    const sale = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"][name="kind"]')][0] as HTMLInputElement;
    await click(sale);
    // Ilk select alici secimi.
    const buyer = container.querySelector('select') as HTMLSelectElement;
    await choose(buyer, 'c');
    await click(button('Boş devralanlara uygula'));
    expect(container.textContent).toContain('Devirden sonra (taslak)');
    expect(container.textContent).toContain('%100');
    expect(button('Önizle').disabled).toBe(false);
  });
});
