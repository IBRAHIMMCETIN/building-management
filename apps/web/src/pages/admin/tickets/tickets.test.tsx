// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { ticketDetailSchema, workCostsSchema, type Ticket, type WorkCosts } from '@/lib/api/tickets';
import { taskSchema } from '@/lib/api/maintenance';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let perms = { canWriteCosts: true, canReadCosts: true };
let costs: WorkCosts;
const addMutate = vi.fn();
vi.mock('@/hooks/useTickets', () => ({
  useTicketPermissions: () => perms,
  useWorkCosts: () => ({ isPending: false, isError: false, data: costs }),
  useUnlinkCost: () => ({ isPending: false, isError: false, mutate: vi.fn() }),
  useAddCost: () => ({ isPending: false, isError: false, mutate: addMutate }),
  useChargeUnit: () => ({ isPending: false, isError: false, mutate: vi.fn() }),
  useExpenseOptions: () => ({ isPending: false, isError: false, data: [] }),
}));
vi.mock('@/hooks/useFinance', () => ({ useFinanceAccounts: () => ({ data: [] }) }));
vi.mock('react-router', () => ({ Link: ({ children }: { children: unknown }) => children }));

const { ticketsCsv } = await import('./TicketList');
const { filterBoardItems } = await import('./TicketBoard');
const { checklistErrors } = await import('./MaintenanceTaskDialog');
const { presetDefaults } = await import('./MaintenanceTemplatesPanel');
const { WorkCostCard } = await import('./WorkCostCard');

const ticket = (over: Partial<Ticket> = {}): Ticket =>
  ticketDetailSchema.shape.ticket.parse({
    ticketId: 't1',
    number: 'T-000001',
    title: 'Banyo; tavan "akıyor"',
    description: 'x',
    category: 'plumbing',
    priority: 'urgent',
    location: { kind: 'unit', unitId: 'u1' },
    status: 'open',
    source: 'resident',
    createdAt: '2026-11-24T08:00:00.000Z',
    dueAt: '2026-11-24T12:00:00.000Z',
    overdue: true,
    version: 1,
    ...over,
  });

describe('API semalari', () => {
  it('talep, sakin gorunumu ve masraf ozeti ayristirilir', () => {
    const r = ticketDetailSchema.parse({
      ticket: { ...ticket(), assigned: true, actions: ['start'], canAssign: true, mine: false },
      events: [{ eventId: 'e1', kind: 'cost_charged', visibility: 'internal', at: '2026-11-24T09:00:00.000Z', amount: 30000, transactionId: 'tx1' }],
    });
    expect(r.ticket.actions).toEqual(['start']);
    expect(r.events[0]?.amount).toBe(30000);
    expect(taskSchema.parse({ taskId: '2026-11-20_t', templateId: 't', dueDate: '2026-11-20', name: 'Hidrofor', kind: 'water_pump', category: 'water_pump', checklist: [], status: 'scheduled', version: 1 }).ticketIds).toEqual([]);
  });
});

describe('liste ve pano yardimcilari', () => {
  it('CSV: noktali virgul, tirnak kacisi, BOM; Turkce etiketler', () => {
    const csv = ticketsCsv([ticket({ assigneeId: 's1' })], { unitLabel: () => '5', nameOf: () => 'Ali Usta' });
    expect(csv.startsWith('﻿Numara;Başlık;')).toBe(true);
    expect(csv).toContain('T-000001;"Banyo; tavan ""akıyor""";Su / tesisat;Acil;Açık;Daire 5;Ali Usta;');
    expect(csv.trimEnd().endsWith('Evet')).toBe(true);
  });

  it('pano filtreleri', () => {
    const items = [ticket(), ticket({ ticketId: 't2', priority: 'low', overdue: false, assigneeId: 's1', category: 'elevator' })];
    expect(filterBoardItems(items, { category: '', priority: '', assignee: 'none', overdue: false }).map((t) => t.ticketId)).toEqual(['t1']);
    expect(filterBoardItems(items, { category: 'elevator', priority: '', assignee: '', overdue: false }).map((t) => t.ticketId)).toEqual(['t2']);
    expect(filterBoardItems(items, { category: '', priority: '', assignee: '', overdue: true }).map((t) => t.ticketId)).toEqual(['t1']);
  });
});

describe('bakim formlari', () => {
  const task = { checklist: [{ id: 'c1', text: 'Fren', required: true }, { id: 'c2', text: 'Not defteri', required: false }] };
  it('kontrol listesi: zorunlu madde cevaplanir, sorunlu maddeye aciklama', () => {
    expect(checklistErrors(task, [{ id: 'c1', ok: null, note: '' }, { id: 'c2', ok: null, note: '' }])).toMatch(/Zorunlu madde.*Fren/);
    expect(checklistErrors(task, [{ id: 'c1', ok: false, note: '' }, { id: 'c2', ok: null, note: '' }])).toMatch(/açıklama gerekli/);
    expect(checklistErrors(task, [{ id: 'c1', ok: false, note: 'Balata aşınmış' }, { id: 'c2', ok: null, note: '' }])).toBeNull();
  });

  it('hazir sablon varsayilanlari', () => {
    expect(presetDefaults({ preset: 'pool', name: 'Havuz bakımı', category: 'pool', every: 1, unit: 'week', checklist: ['Klor ölçüldü'], legalNote: undefined })).toMatchObject({
      name: 'Havuz bakımı',
      unit: 'week',
      checklist: [{ text: 'Klor ölçüldü', required: true }],
      expenseAccountId: '',
    });
    expect(presetDefaults(undefined)).toMatchObject({ name: '', category: 'other', every: 1, unit: 'month', checklist: [] });
  });
});

describe('masraf karti', () => {
  let container: HTMLDivElement;
  afterEach(() => {
    container?.remove();
    document.body.innerHTML = '';
  });
  const render = async () => {
    container = document.createElement('div');
    document.body.append(container);
    await act(async () => createRoot(container).render(<WorkCostCard target={{ kind: 'ticket', id: 't1' }} />));
    return container.textContent ?? '';
  };
  const base = workCostsSchema.parse({
    target: { kind: 'ticket', id: 't1', label: 'T-000001 Banyo', status: 'resolved', unitId: 'u1' },
    items: [
      { expenseId: 'e1', transactionId: 'x1', amount: 125050, mode: 'expense', date: '2026-11-24', description: 'Tesisatçı', linkedAt: 'a', linkedBy: 'm', reversed: false },
      { expenseId: 'e2', transactionId: 'x2', amount: 1000, mode: 'link', date: '2026-11-24', description: 'Conta', linkedAt: 'a', linkedBy: 'm', reversed: true },
    ],
    recharges: [],
    total: 125050,
    rechargedTotal: 0,
    rechargeable: 125050,
    suggestion: { expenseAccountId: 'exp-repair' },
  });

  it('yonetim: toplam, iptal etiketi, baglama ve daireye yansitma dugmeleri', async () => {
    perms = { canWriteCosts: true, canReadCosts: true };
    costs = base;
    const text = await render();
    expect(text).toContain('İptal (ters kayıt)');
    expect(text).toContain('Yeni gider');
    expect(text).toContain('Var olan gideri bağla');
    expect(text).toContain('Daireye yansıt');
    expect(container.querySelectorAll('[aria-label$="bağını kaldır"]')).toHaveLength(1);
  });

  it('denetci salt okur; yansitilabilir tutar yoksa dugme yok', async () => {
    perms = { canWriteCosts: false, canReadCosts: true };
    costs = { ...base, rechargeable: 0 };
    const text = await render();
    expect(text).not.toContain('Yeni gider');
    expect(text).not.toContain('Daireye yansıt');
  });

  const setValue = async (el: Element | null | undefined, value: string) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

  it('daire ici talepte yeni gider: tek adimda daireye yansitma secenegi gidere eklenir', async () => {
    perms = { canWriteCosts: true, canReadCosts: true };
    costs = base;
    addMutate.mockClear();
    await render();
    await act(async () => button('Yeni gider').click());
    expect(document.body.textContent).toContain('Gideri kaydettikten sonra doğrudan bu daireye');
    await setValue(document.querySelector('input[inputmode="decimal"]'), '500');
    const box = [...document.querySelectorAll('input[type="checkbox"]')].find((c) => c.parentElement?.textContent?.includes('borç olarak yansıt')) as HTMLInputElement;
    await act(async () => box.click());
    expect(button('Gideri kaydet').disabled).toBe(true); // son odeme tarihi zorunlu
    await act(async () => (document.querySelector('input[name="inline-party"]:not(:checked)') as HTMLInputElement).click()); // kat maliki
    const dates = document.querySelectorAll('input[type="date"]');
    await setValue(dates[dates.length - 1], '2026-12-20');
    await act(async () => button('Gideri kaydet').click());
    expect(addMutate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'expense', amount: 50000, recharge: { liableParty: 'owner', dueDate: '2026-12-20' } }),
      expect.anything(),
    );
  });

  it('ortak alan talebinde ve bakim gorevinde yansitma secenegi yok', async () => {
    perms = { canWriteCosts: true, canReadCosts: true };
    costs = { ...base, target: { ...base.target, unitId: undefined } };
    await render();
    await act(async () => button('Yeni gider').click());
    expect(document.body.textContent).not.toContain('Gideri kaydettikten sonra doğrudan bu daireye');
  });
});
