// @vitest-environment happy-dom
import { type ReactNode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { type Equipment, type EquipmentHistory, equipmentSchema, historySchema } from '@/lib/api/equipment';
import { ticketSchema } from '@/lib/api/tickets';
import { taskSchema } from '@/lib/api/maintenance';
import { daysLeftText, equipmentDisplayName, equipmentLocationText } from '@/lib/equipment/model';
import { navItemsFor } from '@/layouts/adminNav';
import { equipmentDefaults, equipmentFormSchema, toEquipmentInput } from './schemas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom <dialog> showModal destegi sinirli: acik kabul et.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

const equipment = (over: Partial<Equipment> = {}): Equipment =>
  equipmentSchema.parse({
    equipmentId: 'e1',
    name: 'A Blok asansörü',
    category: 'elevator',
    blockId: 'b1',
    brand: 'Otis',
    serialNumber: 'SN-1001',
    warrantyEndDate: '2026-12-10',
    serviceCompany: { name: 'Yıldız Asansör', phone: '0212 555 00 00' },
    status: 'active',
    documents: [{ documentId: 'd1', kind: 'inspection', title: 'Etiket 2026', fileName: 'etiket.jpg', contentType: 'image/jpeg', size: 10, uploadedAt: '2026-11-20T08:00:00.000Z', uploadedBy: 'mgr', status: 'active' }],
    expiry: [{ equipmentId: 'e1', name: 'A Blok asansörü', kind: 'warranty', date: '2026-12-10', expired: false, daysLeft: 15 }],
    canEdit: true,
    version: 3,
    ...over,
  });

const history = (withCosts: boolean): EquipmentHistory =>
  historySchema.parse({
    equipmentId: 'e1',
    name: 'A Blok asansörü',
    items: [
      { kind: 'ticket', id: 't1', date: '2026-11-25', number: 'T-000004', title: 'Kapı kapanmıyor', status: 'open', ...(withCosts ? { cost: 150000 } : {}) },
      { kind: 'maintenance', id: '2026-10-25_tpl', date: '2026-10-26', title: 'Asansör aylık bakımı', status: 'done', estimate: 40000 },
    ],
    counts: { tickets: 1, openTickets: 1, maintenance: 1, maintenanceDone: 1 },
    templates: [{ templateId: 'tpl', name: 'Asansör aylık bakımı' }],
    ...(withCosts ? { costs: { total: 190000, ticket: 150000, maintenance: 40000, byYear: [{ year: '2026', total: 190000, ticket: 150000, maintenance: 40000, count: 2 }] } } : {}),
  });

describe('ekipman formu', () => {
  it('bos alanlar null gider (duzenlemede temizler); servis firmasi tamamen bossa null', () => {
    const v = equipmentFormSchema.parse({ ...equipmentDefaults(), name: 'Hidrofor', category: 'water_pump', serialNumber: ' HF-9 ' });
    const input = toEquipmentInput(v);
    expect(input).toMatchObject({ name: 'Hidrofor', category: 'water_pump', serialNumber: 'HF-9', blockId: null, warrantyEndDate: null, serviceCompany: null, inspectionLabel: null, notes: null });
    const withService = toEquipmentInput(equipmentFormSchema.parse({ ...equipmentDefaults(), name: 'Hidrofor', servicePhone: '0212 555 00 00' }));
    expect(withService.serviceCompany).toEqual({ supplierAccountId: null, name: null, phone: '0212 555 00 00', email: null });
  });

  it('API ile ayni kurallar: garanti kurulumdan, sonraki kontrol son kontrolden once olamaz; telefon / e-posta', () => {
    const base = { ...equipmentDefaults(), name: 'Jeneratör', category: 'generator' as const };
    const issues = (over: Record<string, string>) => {
      const r = equipmentFormSchema.safeParse({ ...base, ...over });
      return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    };
    expect(issues({ installDate: '2026-05-01', warrantyEndDate: '2026-04-01' })).toEqual(['warrantyEndDate']);
    expect(issues({ lastInspectionDate: '2026-05-01', nextInspectionDate: '2026-04-01' })).toEqual(['nextInspectionDate']);
    expect(issues({ servicePhone: 'ara beni', serviceEmail: 'yok' })).toEqual(['servicePhone', 'serviceEmail']);
    expect(issues({ name: 'x' })).toEqual(['name']);
    expect(issues({})).toEqual([]);
  });

  it('duzenleme varsayilanlari kayittan gelir', () => {
    expect(equipmentDefaults(equipment())).toMatchObject({ name: 'A Blok asansörü', blockId: 'b1', serviceName: 'Yıldız Asansör', servicePhone: '0212 555 00 00', inspectionLabel: '' });
  });
});

describe('model ve semalar', () => {
  it('kalan gun metni ve konum', () => {
    expect(daysLeftText(0)).toBe('bugün');
    expect(daysLeftText(12)).toBe('12 gün kaldı');
    expect(daysLeftText(-5)).toBe('5 gün geçti');
    expect(equipmentLocationText({ blockId: 'b1', location: 'bodrum' }, () => 'A Blok')).toBe('A Blok · bodrum');
    expect(equipmentLocationText({}, () => undefined)).toBe('Site geneli');
    expect(equipmentDisplayName({ name: 'Jeneratör', status: 'retired' })).toBe('Jeneratör (hizmet dışı)');
    expect(equipmentDisplayName({ name: 'Jeneratör', status: 'out_of_service' })).toBe('Jeneratör');
  });

  it('talep ve gorev: ekipman baglantisi ve tahmini tutar ayristirilir; sakin gorunumunde alanlar yok', () => {
    const t = ticketSchema.parse({
      ticketId: 't1', number: 'T-1', title: 'x', description: 'x', category: 'elevator', priority: 'normal', location: { kind: 'common', area: 'Lobi' }, status: 'assigned', source: 'staff', createdAt: '2026-11-25T08:00:00.000Z', dueAt: '2026-11-26T08:00:00.000Z', version: 2,
      equipmentId: 'e1', estimate: { amount: 125050, note: 'Conta', at: '2026-11-25T09:00:00.000Z', by: 'staff-1' }, canEstimate: true,
    });
    expect(t).toMatchObject({ equipmentId: 'e1', estimate: { amount: 125050 }, canEstimate: true });
    const resident = ticketSchema.parse({ ...t, equipmentId: undefined, estimate: undefined, canEstimate: undefined });
    expect(resident.estimate).toBeUndefined();
    expect(resident.canEstimate).toBe(false);
    expect(taskSchema.parse({ taskId: '2026-11-20_t', templateId: 't', dueDate: '2026-11-20', name: 'Hidrofor', kind: 'water_pump', category: 'water_pump', checklist: [], status: 'scheduled', version: 1, equipmentId: 'e2', estimate: { amount: 1, at: 'x', by: 'y' } })).toMatchObject({ equipmentId: 'e2', estimate: { amount: 1 } });
  });

  it('menu: Ekipman yonetim, gorevli ve denetciye; guvenlik gormez; Ariza & Bakim yaninda', () => {
    const paths = (role: Parameters<typeof navItemsFor>[0]) => navItemsFor(role).map((n) => n.to);
    for (const role of ['apartment_manager', 'management_company', 'building_staff', 'observer'] as const) expect(paths(role)).toContain('/admin/equipment');
    expect(paths('security_guard')).not.toContain('/admin/equipment');
    const manager = paths('apartment_manager');
    expect(manager.indexOf('/admin/equipment')).toBe(manager.indexOf('/admin/tickets') + 1);
  });
});

// --- Ayrinti paneli ve tahmini tutar karti ---------------------------------------

let perms = { canRead: true, canWrite: true, canReadCosts: true };
let detail: Equipment = equipment();
let hist: EquipmentHistory = history(true);
const mutation = () => ({ isPending: false, isError: false, error: null, reset: vi.fn(), mutate: vi.fn(), mutateAsync: vi.fn(), variables: undefined });
const status = mutation();
vi.mock('@/hooks/useEquipment', () => ({
  useEquipmentPermissions: () => perms,
  useEquipment: () => ({ isPending: false, isError: false, data: detail }),
  useEquipmentHistory: () => ({ isPending: false, isError: false, data: hist }),
  useEquipmentStatus: () => status,
  useAddEquipmentDocument: () => mutation(),
  useArchiveEquipmentDocument: () => mutation(),
  useSaveEquipment: () => save,
  useEquipmentSearch: (term: string) => ({ data: search(term) }),
  useEquipmentNames: () => (id: string) => (id === 'e-old' ? 'Eski jeneratör (hizmet dışı)' : undefined),
}));
vi.mock('@/hooks/useFinance', () => ({ useFinanceAccounts: () => ({ data: [{ accountId: 'sup-new', name: 'Kuzey Servis', type: 'payable', status: 'active' }] }) }));
vi.mock('react-router', () => ({ Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a> }));
const save = { ...mutation(), mutateAsync: vi.fn().mockResolvedValue({ equipment: { equipmentId: 'e1' } }) };
let searchTerms: string[] = [];
const search = (term: string) => {
  searchTerms.push(term);
  const all = Array.from({ length: 60 }, (_, i) => equipment({ equipmentId: `e${i}`, name: `Ekipman ${i}` }));
  const hits = term ? all.filter((e) => e.name.endsWith(term)) : all.slice(0, 2);
  return { items: hits, total: term ? hits.length : all.length, expiringCount: 0 };
};

const { EquipmentDetailPanel } = await import('./EquipmentDetailPanel');
const { EquipmentDialog } = await import('./EquipmentDialog');
const { EstimateCard } = await import('../tickets/EstimateCard');
const { EquipmentSelect } = await import('../tickets/EquipmentSelect');

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  vi.clearAllMocks();
});
async function render(node: ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () => createRoot(container).render(node));
}
const byText = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
const type = async (el: Element | null, value: string) => {
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('ekipman ayrintisi', () => {
  it('yonetim: bilgiler, hatirlatma, belgeler, gecmis baglantilari ve yil bazinda masraf tablosu', async () => {
    perms = { canRead: true, canWrite: true, canReadCosts: true };
    detail = equipment();
    hist = history(true);
    await render(<EquipmentDetailPanel equipmentId="e1" onClose={vi.fn()} onEdit={vi.fn()} blockName={() => 'A Blok'} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Garanti bitişi: 10 Ara 2026 (15 gün kaldı)');
    expect(text).toContain('Yıldız Asansör');
    expect(text).toContain('Etiket 2026');
    expect(container.querySelector('caption')?.textContent).toBe('Yıllara göre masraflar');
    expect(text).toContain('₺1.900,00');
    expect(container.querySelector('a[href="/admin/tickets?tab=list&ticket=t1"]')).not.toBeNull();
    expect(container.querySelector('a[href="/admin/tickets?tab=calendar&task=2026-10-25_tpl"]')).not.toBeNull();
    expect(byText('Düzenle')).toBeDefined();
    expect(byText('Belge ekle')).toBeDefined();
    // Hizmetten cikarma gerekce ister.
    await act(async () => byText('Hizmetten çıkar')?.click());
    const submit = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Hizmetten çıkar').at(-1) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await type(container.querySelector('textarea'), 'Yenisiyle değiştirildi');
    await act(async () => submit.click());
    expect(status.mutate).toHaveBeenCalledWith({ id: 'e1', version: 3, status: 'retired', note: 'Yenisiyle değiştirildi' }, expect.anything());
  });

  it('gorevli: masraf tablosu ve duzenleme dugmeleri yok', async () => {
    perms = { canRead: true, canWrite: false, canReadCosts: false };
    detail = equipment({ canEdit: false });
    hist = history(false);
    await render(<EquipmentDetailPanel equipmentId="e1" onClose={vi.fn()} onEdit={vi.fn()} blockName={() => 'A Blok'} />);
    expect(container.querySelector('caption')).toBeNull();
    expect(byText('Düzenle')).toBeUndefined();
    expect(byText('Belge ekle')).toBeUndefined();
    expect(byText('Hizmetten çıkar')).toBeUndefined();
    expect(container.textContent).toContain('görevli tahmini ₺400,00');
  });
});

describe('tahmini tutar karti', () => {
  it('TL girisi kurusa cevrilir, surumle gonderilir; bilgi amacli notu gosterilir', async () => {
    const m = mutation();
    await render(<EstimateCard canEdit version={4} mutation={m} nameOf={() => 'Ali'} />);
    expect(container.textContent).toContain('Finans’a kaydedilmez, sakin görmez');
    await act(async () => byText('Tutar gir')?.click());
    const [amount, note] = [...container.querySelectorAll('input')];
    const save = byText('Kaydet') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await type(amount ?? null, '1.250,50');
    await type(note ?? null, 'Conta ve işçilik');
    await act(async () => (byText('Kaydet') as HTMLButtonElement).click());
    expect(m.mutate).toHaveBeenCalledWith({ version: 4, amount: 125050, note: 'Conta ve işçilik' }, expect.anything());
  });

  it('duzenleme yetkisi ve not yoksa hic gorunmez; varsa okunur', async () => {
    await render(<EstimateCard canEdit={false} version={1} mutation={mutation()} nameOf={() => undefined} />);
    expect(container.textContent).toBe('');
    container.remove();
    await render(<EstimateCard estimate={{ amount: 50000, at: '2026-11-25T09:00:00.000Z', by: 'staff-1' }} canEdit={false} version={1} mutation={mutation()} nameOf={() => 'Ali'} />);
    expect(container.textContent).toContain('₺500,00');
    expect(container.textContent).toContain('Ali');
    expect(byText('Düzenle')).toBeUndefined();
  });

  it('sifir tutar gecerli bir tahmindir', async () => {
    const m = mutation();
    await render(<EstimateCard canEdit version={2} mutation={m} nameOf={() => undefined} />);
    await act(async () => byText('Tutar gir')?.click());
    await type(container.querySelector('input'), '0');
    const saveButton = byText('Kaydet') as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    await act(async () => saveButton.click());
    expect(m.mutate).toHaveBeenCalledWith({ version: 2, amount: 0 }, expect.anything());
  });
});

describe('ekipman secimi ve tedarikci', () => {
  it('sunucu aramasi: liste kesilince arama kutusu ve sayi; bagli hizmet disi ekipman secili gorunur', async () => {
    searchTerms = [];
    const onChange = vi.fn();
    await render(<EquipmentSelect label="Ekipman" value="e-old" onChange={onChange} />);
    expect(container.textContent).toContain('60 kayıttan 2 tanesi gösteriliyor');
    const options = [...container.querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toEqual(['Bağlı değil', 'Eski jeneratör (hizmet dışı)', 'Ekipman 0', 'Ekipman 1']);
    await type(container.querySelector('input[aria-label="Ekipman ara"]'), '42');
    expect(searchTerms.at(-1)).toBe('42');
    expect([...container.querySelectorAll('option')].map((o) => o.textContent)).toContain('Ekipman 42');
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      select.value = 'e42';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('e42', expect.objectContaining({ name: 'Ekipman 42' }));
  });

  it('pasif tedarikci carisi secili kalir; cari degisince firma adi yenilenir', async () => {
    const e = equipment({ serviceCompany: { supplierAccountId: 'sup-old', name: 'Yıldız Asansör' } });
    await render(<EquipmentDialog open onClose={vi.fn()} equipment={e} blocks={[]} />);
    const supplier = [...container.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'sup-new')) as HTMLSelectElement;
    expect(supplier.value).toBe('sup-old');
    expect([...supplier.options].map((o) => o.textContent)).toContain('Yıldız Asansör (pasif)');
    await act(async () => {
      supplier.value = 'sup-new';
      supplier.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const name = [...container.querySelectorAll('input')].find((i) => i.value === 'Kuzey Servis');
    expect(name).toBeDefined();
  });
});
