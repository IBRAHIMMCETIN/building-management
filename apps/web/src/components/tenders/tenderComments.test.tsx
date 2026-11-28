// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { type TenderComment, commentSchema } from '@/lib/api/tenders';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { TenderComments, quoteOf } = await import('./TenderComments');

const c = (over: Partial<TenderComment>): TenderComment =>
  commentSchema.parse({ commentId: 'c1', body: 'Teklif KDV dahil mi?', authorKind: 'resident', mine: false, createdAt: '2026-11-27T07:00:00.000Z', ...over });

let container: HTMLDivElement;
afterEach(() => container?.remove());
async function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () => createRoot(container).render(node));
}
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const type = async (el: HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('ihale sorulari: moderasyon ve belirli soruya yanit', () => {
  it('yonetim: soruya "Yanıtla" yanit bagini gonderir, "Gizle" gizleme akisini acar; gizlenen soru rozet ve gerekceyle', async () => {
    const onSubmit = vi.fn(async () => ({}));
    const onHide = vi.fn();
    const comments = [
      c({}),
      c({ commentId: 'c2', body: 'Uygunsuz soru', hidden: { at: '2026-11-27T08:00:00.000Z', reason: 'Kişisel iddia', by: 'mgr' } }),
      c({ commentId: 'c3', body: 'Evet, KDV dahil.', authorKind: 'management', replyTo: 'c1' }),
    ];
    await render(<TenderComments comments={comments} canComment as="management" pending={false} onSubmit={onSubmit} onHide={onHide} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Gizlendi');
    expect(text).toContain('Sakinlere gösterilmiyor. Gerekçe: Kişisel iddia');
    expect(text).toContain('Yanıtlanan soru: “Teklif KDV dahil mi?”');
    // Gizlenen soruda ve yonetim yanitinda islem dugmesi yok.
    expect([...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Gizle')).toHaveLength(1);
    await act(async () => button('Gizle')?.click());
    expect(onHide).toHaveBeenCalledWith(expect.objectContaining({ commentId: 'c1' }));
    await act(async () => button('Yanıtla')?.click());
    expect(container.textContent).toContain('Bu soruya yanıt (yalnızca soran sakine bildirim gider)');
    await type(container.querySelector('textarea') as HTMLTextAreaElement, 'Evet, toplam 108.000 TL.');
    const submit = [...container.querySelectorAll('button[type="submit"]')][0] as HTMLButtonElement;
    await act(async () => submit.click());
    expect(onSubmit).toHaveBeenCalledWith({ idempotencyKey: expect.any(String), body: 'Evet, toplam 108.000 TL.', replyTo: 'c1' });
    // Gonderimden sonra yanit bagi temizlenir: sonraki yanit genel.
    expect(container.textContent).not.toContain('Bu soruya yanıt');
  });

  it('sakin: islem dugmesi yok; yanitlanan soru gorunmuyorsa (gizlendi) alinti yok', async () => {
    const comments = [c({ commentId: 'c3', body: 'Yanıt metni', authorKind: 'management', replyTo: 'cX' }), c({ commentId: 'c4', body: 'Sorum', mine: true })];
    await render(<TenderComments comments={comments} canComment as="resident" pending={false} onSubmit={vi.fn()} />);
    expect(button('Yanıtla')).toBeUndefined();
    expect(button('Gizle')).toBeUndefined();
    expect(container.textContent).not.toContain('Yanıtlanan soru');
    expect(quoteOf('x'.repeat(100))).toHaveLength(80);
  });
});
