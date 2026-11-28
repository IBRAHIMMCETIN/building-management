// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Opts = { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void };
const createPass = { isPending: false, mutate: vi.fn((_input: { idempotencyKey: string }, opts?: Opts) => opts?.onError?.(new Error('ağ hatası'))) };
vi.mock('@/hooks/useGate', () => ({ useMyGateActions: () => ({ createPass }) }));

const { NewPassDialog } = await import('./NewPassDialog');

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  vi.clearAllMocks();
});
async function render() {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () =>
    createRoot(container).render(<NewPassDialog open onClose={() => undefined} units={[{ unitId: 'u1', label: 'A Blok · 5' }]} limits={{ maxPassDays: 31, maxPassLeadDays: 90 }} onCreated={() => undefined} />),
  );
}
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('eleman yok');
  await act(async () => (el as HTMLElement).click());
};
const typeName = async (value: string) => {
  const input = container.querySelector('input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('sakin misafir gecisi penceresi', () => {
  it('islem anahtari: ayni acilistaki tekrar ayni; pencere kapatilinca yenilenir', async () => {
    await render();
    await typeName('Ayşe Demir');
    await click(button('Geçiş oluştur'));
    await click(button('Geçiş oluştur'));
    await click(button('Vazgeç'));
    await typeName('Ayşe Demir');
    await click(button('Geçiş oluştur'));
    const keys = createPass.mutate.mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});
