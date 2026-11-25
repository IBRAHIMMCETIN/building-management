// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { ticketEmailsEnabled } from '@/lib/api/notificationPreferences';
import { awaitsMyConfirmation } from '@/lib/api/portalTickets';
import { type Ticket, ticketSchema } from '@/lib/api/tickets';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mutation = () => ({ isPending: false, isError: false, error: null, mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({ ticket: { ticketId: 'new-1' } }) });
const actions = { comment: mutation(), confirm: mutation(), reopen: mutation(), cancel: mutation() };
const create = mutation();
let detail: { ticket: Ticket; events: [] };
let similar: { number: string; category: string; area: string; status: string; createdAt: string; mine: boolean }[] = [];

vi.mock('@/hooks/usePortalTickets', () => ({
  useMyTicket: () => ({ isPending: false, isError: false, data: detail }),
  useMyTicketActions: () => actions,
  useCreateMyTicket: () => create,
  useSimilarTickets: (c: string | null) => ({ data: c ? similar : [] }),
}));
vi.mock('@/hooks/usePortal', () => ({ useMySummary: () => ({ isPending: false, data: { unitId: 'u1', unitLabel: 'A Blok 5' }, error: null }) }));
vi.mock('@/context/PortalUnitContext', () => ({ usePortalUnit: () => ({ unitId: undefined, selectUnit: vi.fn() }) }));
const navigate = vi.fn();
vi.mock('react-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  useParams: () => ({ ticketId: 't1' }),
  useNavigate: () => navigate,
}));

const { MyTicketDetailPage } = await import('./MyTicketDetailPage');
const { NewTicketWizard } = await import('./NewTicketWizard');

const ticket = (over: Partial<Ticket> = {}) =>
  ticketSchema.parse({
    ticketId: 't1',
    number: 'T-000007',
    title: 'Banyo tavanı akıyor',
    description: 'Dün geceden beri',
    category: 'plumbing',
    priority: 'normal',
    location: { kind: 'unit', unitId: 'u1' },
    status: 'resolved',
    source: 'resident',
    createdAt: '2026-11-20T08:00:00.000Z',
    dueAt: '2026-11-23T08:00:00.000Z',
    assigned: true,
    actions: ['confirm', 'reopen'],
    version: 4,
    ...over,
  });

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  vi.clearAllMocks();
});
async function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () => createRoot(container).render(node));
}
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('eleman yok');
  await act(async () => (el as HTMLElement).click());
};
const byText = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
const type = async (el: Element | null, value: string) => {
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('yardimcilar', () => {
  it('onay bekleyen talep ve ariza e-postasi tercihi', () => {
    expect(awaitsMyConfirmation({ status: 'resolved', actions: ['confirm'] })).toBe(true);
    expect(awaitsMyConfirmation({ status: 'resolved', actions: [] })).toBe(false);
    expect(ticketEmailsEnabled({ email: { enabled: true } })).toBe(true);
    expect(ticketEmailsEnabled({ email: { enabled: true, tickets: false } })).toBe(false);
  });
});

describe('sakin talep ayrintisi', () => {
  it('cozulen talep: 1-5 puanla onay, "hala sorun var" ile yeniden acma', async () => {
    detail = { ticket: ticket(), events: [] };
    await render(<MyTicketDetailPage />);
    expect(container.textContent).toContain('Sorun çözüldü mü?');
    await click(container.querySelector('[aria-label="4 - İyi"]'));
    await click(byText('Onayla ve kapat'));
    expect(actions.confirm.mutate).toHaveBeenCalledWith({ version: 4, rating: 4 });

    await click(byText('Hâlâ sorun var'));
    expect(container.textContent).toContain('Talebi yeniden aç');
    expect(byText('Yeniden aç')?.disabled).toBe(true);
    await type(container.querySelector('textarea'), 'Damlama devam ediyor');
    await click(byText('Yeniden aç'));
    expect(actions.reopen.mutate).toHaveBeenCalledWith({ version: 4, note: 'Damlama devam ediyor' });
  });

  it('acik ve atanmamis talep geri cekilebilir; onay karti yok', async () => {
    detail = { ticket: ticket({ status: 'open', actions: ['cancel'], assigned: false }), events: [] };
    window.confirm = vi.fn(() => true);
    await render(<MyTicketDetailPage />);
    expect(container.textContent).not.toContain('Sorun çözüldü mü?');
    await click(byText('Talebi geri çek'));
    expect(actions.cancel.mutate).toHaveBeenCalledWith({ version: 4 });
  });
});

describe('yeni talep sihirbazi', () => {
  it('ortak alan: benzer acik talep uyarisi (kendi talebim haric), aciklama ve gonderim', async () => {
    similar = [
      { number: 'T-000003', category: 'elevator', area: 'B blok asansörü', status: 'assigned', createdAt: '2026-11-24T08:00:00.000Z', mine: false },
      { number: 'T-000004', category: 'elevator', area: 'A blok', status: 'open', createdAt: '2026-11-24T08:00:00.000Z', mine: true },
    ];
    await render(<NewTicketWizard />);
    expect(container.textContent).toContain('Daire içi · A Blok 5');
    await click(byText('Ortak alan'));
    await type(container.querySelector('input'), 'B blok asansörü');
    await click(byText('Devam'));
    await click(byText('Asansör'));
    expect(container.textContent).toContain('Ortak alanda bu kategoride açık talep var');
    expect(container.textContent).toContain('T-000003');
    expect(container.textContent).not.toContain('T-000004');
    await click(byText('Devam'));
    const [title] = container.querySelectorAll('input');
    await type(title ?? null, 'Asansör katta durmuyor');
    await type(container.querySelector('textarea'), '3. katta kapı açılmıyor');
    await click(byText('Talebi gönder'));
    expect(create.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ title: 'Asansör katta durmuyor', category: 'elevator', location: { kind: 'common', area: 'B blok asansörü' } }));
    expect(navigate).toHaveBeenCalledWith('/app/talepler/new-1', { replace: true });
  });
});
