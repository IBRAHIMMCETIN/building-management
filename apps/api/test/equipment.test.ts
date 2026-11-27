/**
 * Ariza & bakim v2: ekipman sicili (kayit, roller, surum, silme yok, filtreler, belgeler / S3
 * anahtarlari), talep ve bakim baglantisi (kiraci izolasyonu), ekipman gecmisi ve masraflar,
 * son tarih hatirlatmalari (gunluk ozet) ve gorevlinin tahmini tutar notu (sakin gormez).
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthClaims } from '../src/auth/claims.js';
import { buildEvent, createInMemoryEventPublisher, type DomainEvent } from '../src/events/publisher.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import { defaultSiteSettings } from '../src/modules/core/service.js';
import type { Block, Site, Unit } from '../src/modules/core/types.js';
import { ValidationError } from '../src/modules/core/validation.js';
import { createMemoryDocumentStore } from '../src/modules/documents/store.js';
import { expiryItems } from '../src/modules/equipment/expiry.js';
import { type EquipmentContext, createEquipmentService } from '../src/modules/equipment/service.js';
import { type Equipment, equipmentDocumentKeys } from '../src/modules/equipment/types.js';
import type { Account } from '../src/modules/finance/types.js';
import { createMaintenanceService } from '../src/modules/maintenance/service.js';
import type { MaintenanceTask } from '../src/modules/maintenance/types.js';
import { renderEmail } from '../src/modules/notifications/templates.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { operationsDigestRecipients } from '../src/modules/tickets/notifications.js';
import { createTicketService } from '../src/modules/tickets/service.js';
import type { Ticket } from '../src/modules/tickets/types.js';
import { createSchedulerWorker } from '../src/workers/scheduler-worker.js';
import { createFakeEquipmentRepo } from './fakes/equipmentRepo.js';
import { createFakeMaintenanceRepo } from './fakes/maintenanceRepo.js';
import { createFakeTicketRepo } from './fakes/ticketRepo.js';

const APT = 'apt-1';
const OTHER = 'apt-2';
const T0 = '2026-11-25T06:00:00.000Z'; // Istanbul 09:00, 25.11.2026
const TODAY = '2026-11-25';

const role = (userId: string, r: string) => ({ userId, apartmentId: APT, role: r, status: 'active', startDate: '2026-01-01', displayName: userId }) as unknown as ApartmentRole;
const roles = [role('staff-1', 'building_staff'), role('staff-2', 'building_staff'), role('mgr', 'apartment_manager')];
const member = { userId: 'res', unitId: 'u1', apartmentId: APT, relation: 'tenant', residesInUnit: true, status: 'active', startDate: '2026-01-01' } as unknown as UnitMembership;
const ctxs = {
  mgr: { apartmentId: APT, userId: 'mgr', role: 'apartment_manager' },
  firm: { apartmentId: APT, userId: 'firm', role: 'management_company' },
  staff1: { apartmentId: APT, userId: 'staff-1', role: 'building_staff' },
  staff2: { apartmentId: APT, userId: 'staff-2', role: 'building_staff' },
  observer: { apartmentId: APT, userId: 'obs', role: 'observer' },
  resident: { apartmentId: APT, userId: 'res', role: 'resident' },
  guard: { apartmentId: APT, userId: 'guard', role: 'security_guard' },
  otherMgr: { apartmentId: OTHER, userId: 'mgr-2', role: 'apartment_manager' },
} satisfies Record<string, EquipmentContext>;

function world() {
  let now = new Date(T0);
  let n = 0;
  const newId = () => `id${String(++n).padStart(6, '0')}`;
  const eq = createFakeEquipmentRepo();
  const fakeTickets = createFakeTicketRepo();
  const fakeMaint = createFakeMaintenanceRepo();
  const docs = createMemoryDocumentStore();
  const site = { siteId: APT, settings: defaultSiteSettings() } as unknown as Site;
  const blocks = [{ blockId: 'b1', status: 'active' }] as unknown as Block[];
  const accounts = [
    { accountId: 'sup-asansor', name: 'Yıldız Asansör Ltd.', type: 'payable', status: 'active' },
    { accountId: 'exp-elevator', name: 'Asansör giderleri', type: 'expense', status: 'active' },
  ] as Account[];
  const reversed = new Set<string>();
  const reversedCalls: string[][] = [];
  const core = {
    getSite: async () => site,
    getUnit: async (_a: string, id: string) => (id === 'u1' ? ({ unitId: 'u1', blockId: 'b1', status: 'active' } as Unit) : undefined),
    getBlock: async (_a: string, id: string) => blocks.find((b) => b.blockId === id),
  };
  const service = createEquipmentService({
    repo: eq.repo,
    core,
    accounts: { getAccount: async (_a, id) => accounts.find((a) => a.accountId === id) },
    tickets: fakeTickets.repo,
    maintenance: fakeMaint.repo,
    finance: { reversedTransactions: async (_c, ids) => { reversedCalls.push([...ids]); return new Set(ids.filter((id) => reversed.has(id))); } },
    store: docs.store,
    now: () => now,
    newId,
  });
  const tickets = createTicketService({
    repo: fakeTickets.repo,
    core,
    memberships: { listMemberships: async (_a, userId) => (userId === 'res' ? [member] : []) },
    roles: { list: async () => roles },
    equipment: eq.repo,
    store: docs.store,
    now: () => now,
    newId,
  });
  const maintenance = createMaintenanceService({
    repo: fakeMaint.repo,
    tickets,
    roles: { list: async () => roles },
    core,
    accounts: { getAccount: async (_a, id) => accounts.find((a) => a.accountId === id) },
    equipment: eq.repo,
    store: docs.store,
    now: () => now,
    newId,
  });
  const elevator = async (extra: Record<string, unknown> = {}) =>
    (await service.create(ctxs.mgr, { name: 'A Blok asansörü', category: 'elevator', blockId: 'b1', brand: 'Otis', model: 'Gen2', serialNumber: 'SN-1001', ...extra })).equipment;
  let k = 0;
  const ticket = async (ctx: EquipmentContext, extra: Record<string, unknown> = {}) =>
    (await tickets.create(ctx, { idempotencyKey: `tk-${++k}`, title: 'Asansör kapısı kapanmıyor', description: 'Kat kapısı takılıyor.', category: 'elevator', location: { kind: 'common', area: 'A Blok' }, ...extra })).ticket;
  /** Tarayicinin S3'e PUT'unu taklit eder. */
  const upload = async (ctx: EquipmentContext, contentType = 'application/pdf', fileName = 'garanti.pdf') => {
    const r = await service.documentUploadUrl(ctx, { fileName, contentType, size: 2048 });
    await docs.store.put(equipmentDocumentKeys.pending(APT, ctx.userId, r.uploadId), new Uint8Array(2048), contentType);
    return r;
  };
  return { eq, fakeTickets, fakeMaint, docs, service, tickets, maintenance, elevator, ticket, upload, reversed, reversedCalls, accounts, setNow: (iso: string) => (now = new Date(iso)) };
}

describe('ekipman sicili', () => {
  it('kayit: servis firmasi tedarikci carisine baglanir, denetim kaydi yazilir; yalnizca yonetim yazar', async () => {
    const w = world();
    const e = await w.elevator({
      installDate: '2024-03-01',
      warrantyEndDate: '2026-12-10',
      serviceCompany: { supplierAccountId: 'sup-asansor', phone: '0212 555 00 00', email: 'servis@yildiz.example' },
      serviceContractEndDate: '2027-02-01',
      nextInspectionDate: '2027-03-01',
      inspectionLabel: 'green',
    });
    expect(e).toMatchObject({ name: 'A Blok asansörü', category: 'elevator', status: 'active', version: 1, canEdit: true, documents: [] });
    expect(e.serviceCompany).toEqual({ supplierAccountId: 'sup-asansor', name: 'Yıldız Asansör Ltd.', phone: '0212 555 00 00', email: 'servis@yildiz.example' });
    expect(e.expiry).toEqual([{ equipmentId: e.equipmentId, name: 'A Blok asansörü', kind: 'warranty', date: '2026-12-10', expired: false, daysLeft: 15 }]);
    expect(w.eq.audits.at(-1)).toMatchObject({ action: 'equipment.create', target: { type: 'equipment', id: e.equipmentId } });
    expect(e).not.toHaveProperty('PK');

    await expect(w.service.create(ctxs.staff1, { name: 'Jeneratör', category: 'generator' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.create(ctxs.observer, { name: 'Jeneratör', category: 'generator' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.list(ctxs.resident)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.list(ctxs.guard)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await w.service.create(ctxs.firm, { name: 'Jeneratör', category: 'generator' })).equipment.status).toBe('active');
    // Gorevli ve denetci okur; duzenleme dugmesi yok.
    expect((await w.service.get(ctxs.staff1, e.equipmentId)).equipment.canEdit).toBe(false);
    expect((await w.service.list(ctxs.observer)).total).toBe(2);
  });

  it('dogrulama: kategori, tarih, telefon / e-posta, tedarikci hesap turu, blok', async () => {
    const w = world();
    await expect(w.service.create(ctxs.mgr, { name: 'x', category: 'elevator' })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.service.create(ctxs.mgr, { name: 'Kazan', category: 'boiler' })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.elevator({ warrantyEndDate: '2026-02-30' })).rejects.toThrow(/YYYY-AA-GG/);
    await expect(w.elevator({ installDate: '2026-05-01', warrantyEndDate: '2026-04-01' })).rejects.toThrow(/kurulum/);
    await expect(w.elevator({ serviceCompany: { phone: 'ara beni' } })).rejects.toThrow(/telefon/);
    await expect(w.elevator({ serviceCompany: { email: 'yok' } })).rejects.toThrow(/e-posta/);
    await expect(w.elevator({ serviceCompany: { supplierAccountId: 'exp-elevator' } })).rejects.toThrow(/tedarikçi/);
    await expect(w.elevator({ blockId: 'b9' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.elevator({ inspectionLabel: 'purple' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('duzenleme surumlu; null alani temizler; degisen alanlar denetime yazilir', async () => {
    const w = world();
    const e = await w.elevator({ warrantyEndDate: '2026-12-10', notes: 'Makine dairesi anahtarı yönetimde' });
    const r = await w.service.update(ctxs.mgr, e.equipmentId, { version: 1, serialNumber: 'SN-2002', notes: null, serviceCompany: { name: 'Kuzey Asansör', phone: '+90 555 111 2233' } });
    expect(r.equipment).toMatchObject({ version: 2, serialNumber: 'SN-2002', serviceCompany: { name: 'Kuzey Asansör' } });
    expect(r.equipment).not.toHaveProperty('notes');
    expect(w.eq.audits.at(-1)).toMatchObject({ action: 'equipment.update', details: { fields: ['serialNumber', 'serviceCompany', 'notes'] } });
    await expect(w.service.update(ctxs.mgr, e.equipmentId, { version: 1, name: 'Eski sürüm' })).rejects.toMatchObject({ code: 'conflict' });
    // Degisiklik yoksa yazim yok.
    const audits = w.eq.audits.length;
    expect((await w.service.update(ctxs.mgr, e.equipmentId, { version: 2, serialNumber: 'SN-2002' })).equipment.version).toBe(2);
    expect(w.eq.audits).toHaveLength(audits);
    await expect(w.service.update(ctxs.staff1, e.equipmentId, { version: 2, name: 'Görevli' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('silme yok: hizmetten cikarma gerekceli bir durumdur; kayit listede `status=all` ile kalir', async () => {
    const w = world();
    const e = await w.elevator();
    await expect(w.service.setStatus(ctxs.mgr, e.equipmentId, { version: 1, status: 'retired' })).rejects.toBeInstanceOf(ValidationError);
    const out = await w.service.setStatus(ctxs.mgr, e.equipmentId, { version: 1, status: 'out_of_service', note: 'Motor arızası' });
    expect(out.equipment).toMatchObject({ status: 'out_of_service', statusNote: 'Motor arızası', version: 2 });
    const retired = await w.service.setStatus(ctxs.mgr, e.equipmentId, { version: 2, status: 'retired', note: 'Yeni asansörle değiştirildi' });
    expect(retired.equipment.status).toBe('retired');
    expect(w.eq.audits.at(-1)).toMatchObject({ action: 'equipment.status', reason: 'Yeni asansörle değiştirildi', details: { from: 'out_of_service', to: 'retired' } });
    expect((await w.service.list(ctxs.mgr)).items).toEqual([]);
    expect((await w.service.list(ctxs.mgr, { status: 'all' })).items.map((x) => x.status)).toEqual(['retired']);
    expect(w.eq.items.size).toBe(1);
    await expect(w.service.setStatus(ctxs.mgr, e.equipmentId, { version: 2, status: 'active' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('arama ve filtreler: q, kategori, blok, garanti N gun icinde, hatirlatma rozeti', async () => {
    const w = world();
    await w.elevator({ warrantyEndDate: '2026-12-20' });
    await w.service.create(ctxs.mgr, { name: 'Hidrofor', category: 'water_pump', brand: 'Grundfos', warrantyEndDate: '2027-06-01' });
    await w.service.create(ctxs.mgr, { name: 'Bariyer', category: 'gate_barrier', serviceContractEndDate: '2026-10-01' });
    const names = async (q: Record<string, string>) => (await w.service.list(ctxs.mgr, q)).items.map((e) => e.name);
    expect(await names({})).toEqual(['A Blok asansörü', 'Bariyer', 'Hidrofor']);
    expect(await names({ q: 'grundfos' })).toEqual(['Hidrofor']);
    expect(await names({ q: 'sn-1001' })).toEqual(['A Blok asansörü']);
    expect(await names({ category: 'water_pump' })).toEqual(['Hidrofor']);
    expect(await names({ blockId: 'b1' })).toEqual(['A Blok asansörü']);
    expect(await names({ warrantyWithin: '30' })).toEqual(['A Blok asansörü']);
    expect(await names({ warrantyWithin: '365' })).toEqual(['A Blok asansörü', 'Hidrofor']);
    expect(await names({ expiring: 'true' })).toEqual(['A Blok asansörü', 'Bariyer']);
    expect((await w.service.list(ctxs.mgr, { category: 'pool' })).expiringCount).toBe(2);
    await expect(w.service.list(ctxs.mgr, { warrantyWithin: '-1' })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.service.list(ctxs.mgr, { category: 'boiler' })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('son tarih hatirlatmalari (saf)', () => {
  const e = (over: Partial<Equipment>): Equipment => ({ equipmentId: 'e1', name: 'Asansör', status: 'active', ...over }) as Equipment;
  it('garanti: 30 gun icinde biten ve son 30 gunde bitmis; sozlesme ve muayene: gecenlerin tumu; hizmetten cikan yok', () => {
    const items = expiryItems(
      [
        e({ equipmentId: 'a', name: 'A', warrantyEndDate: '2026-12-25' }),
        e({ equipmentId: 'b', name: 'B', warrantyEndDate: '2026-11-10' }),
        e({ equipmentId: 'c', name: 'C', warrantyEndDate: '2026-09-01', serviceContractEndDate: '2025-01-31', nextInspectionDate: '2026-12-26' }),
        e({ equipmentId: 'd', name: 'D', warrantyEndDate: '2026-12-01', status: 'retired' }),
        e({ equipmentId: 'f', name: 'F', warrantyEndDate: '2026-12-26' }),
      ],
      TODAY,
    );
    expect(items.map((i) => [i.equipmentId, i.kind, i.date, i.expired, i.daysLeft])).toEqual([
      ['c', 'contract', '2025-01-31', true, -663],
      ['b', 'warranty', '2026-11-10', true, -15],
      ['a', 'warranty', '2026-12-25', false, 30],
    ]);
    expect(expiryItems([e({ nextInspectionDate: '2026-12-26' })], TODAY, { days: 31 })).toHaveLength(1);
  });

  it('GET /expiring gun parametresi; out_of_service dahil', async () => {
    const w = world();
    const x = await w.elevator({ nextInspectionDate: '2026-12-05' });
    await w.service.setStatus(ctxs.mgr, x.equipmentId, { version: 1, status: 'out_of_service' });
    expect((await w.service.expiring(ctxs.staff1)).items).toMatchObject([{ kind: 'inspection', date: '2026-12-05', daysLeft: 10 }]);
    expect((await w.service.expiring(ctxs.mgr, { days: '5' })).items).toEqual([]);
    await expect(w.service.expiring(ctxs.mgr, { days: '0' })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('belgeler (private S3, imzali URL)', () => {
  it('yukleme gecici anahtara, ekleme kalici anahtara kopyalar; anahtar istemciye donmez; surumlu', async () => {
    const w = world();
    const e = await w.elevator();
    const up = await w.upload(ctxs.mgr);
    expect(up.uploadId).toMatch(/^[a-f0-9]{24}_pdf$/);
    expect(up.uploadUrl).toContain(`memory://put/tmp/${APT}/equipment-uploads/mgr/${up.uploadId.replace('_', '.')}`);
    expect(up.uploadUrl).toContain('ttl=300');
    const r = await w.service.addDocument(ctxs.mgr, e.equipmentId, { version: 1, uploadId: up.uploadId, fileName: 'Garanti belgesi.pdf', kind: 'warranty', validUntil: '2028-01-01' });
    expect(r.document).toMatchObject({ kind: 'warranty', title: 'Garanti belgesi.pdf', contentType: 'application/pdf', size: 2048, status: 'active', validUntil: '2028-01-01' });
    expect(r.document).not.toHaveProperty('key');
    expect(r.equipment.documents[0]).not.toHaveProperty('key');
    const stored = w.eq.items.get(`APT#${APT}|EQUIP#${e.equipmentId}`)?.documents[0];
    expect(stored?.key).toBe(`apartments/${APT}/equipment/${e.equipmentId}/${r.document.documentId}.pdf`);
    expect(w.docs.objects.has(stored?.key as string)).toBe(true);
    expect(w.eq.audits.at(-1)).toMatchObject({ action: 'equipment.document_add', details: { kind: 'warranty' } });
    const url = await w.service.documentUrl(ctxs.observer, e.equipmentId, r.document.documentId);
    expect(url.url).toContain(`memory://get/apartments/${APT}/equipment/${e.equipmentId}/`);
    // Eski surumle ekleme reddedilir; yuklenmemis dosya reddedilir.
    const up2 = await w.upload(ctxs.mgr);
    await expect(w.service.addDocument(ctxs.mgr, e.equipmentId, { version: 1, uploadId: up2.uploadId, fileName: 'x.pdf', kind: 'other' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(w.service.addDocument(ctxs.mgr, e.equipmentId, { version: 2, uploadId: `${'a'.repeat(24)}_pdf`, fileName: 'x.pdf', kind: 'other' })).rejects.toThrow(/yüklenmemiş/);
    // Baska kullanicinin yuklemesi eklenemez (anahtar kullaniciya bagli).
    await expect(w.service.addDocument(ctxs.firm, e.equipmentId, { version: 2, uploadId: up2.uploadId, fileName: 'x.pdf', kind: 'other' })).rejects.toThrow(/yüklenmemiş/);
  });

  it('desteklenmeyen tur ve boyut; gorevli yukleyemez', async () => {
    const w = world();
    await expect(w.service.documentUploadUrl(ctxs.mgr, { fileName: 'a.exe', contentType: 'application/x-msdownload', size: 10 })).rejects.toMatchObject({ code: 'unprocessable' });
    await expect(w.service.documentUploadUrl(ctxs.mgr, { fileName: 'a.pdf', contentType: 'application/pdf', size: 11 * 1024 * 1024 })).rejects.toThrow(/10 MB/);
    await expect(w.service.documentUploadUrl(ctxs.staff1, { fileName: 'a.pdf', contentType: 'application/pdf', size: 10 })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('gorevli sozlesme ve arsivlenmis belgeyi goremez; arsivleme silmez', async () => {
    const w = world();
    const e = await w.elevator();
    const a = await w.upload(ctxs.mgr);
    const contract = (await w.service.addDocument(ctxs.mgr, e.equipmentId, { version: 1, uploadId: a.uploadId, fileName: 'sozlesme.pdf', kind: 'contract' })).document;
    const b = await w.upload(ctxs.mgr, 'image/jpeg', 'etiket.jpg');
    const label = (await w.service.addDocument(ctxs.mgr, e.equipmentId, { version: 2, uploadId: b.uploadId, fileName: 'etiket.jpg', kind: 'inspection', title: 'Periyodik kontrol etiketi 2026' })).document;
    expect((await w.service.get(ctxs.staff1, e.equipmentId)).equipment.documents.map((d) => d.kind)).toEqual(['inspection']);
    await expect(w.service.documentUrl(ctxs.staff1, e.equipmentId, contract.documentId)).rejects.toMatchObject({ code: 'not_found' });
    expect((await w.service.documentUrl(ctxs.staff1, e.equipmentId, label.documentId)).contentType).toBe('image/jpeg');

    const archived = await w.service.archiveDocument(ctxs.mgr, e.equipmentId, label.documentId, { version: 3 });
    expect(archived.equipment.documents.map((d) => [d.kind, d.status])).toEqual([
      ['contract', 'active'],
      ['inspection', 'archived'],
    ]);
    expect(archived.equipment.documentCount).toBe(1);
    expect((await w.service.get(ctxs.staff1, e.equipmentId)).equipment.documents).toEqual([]);
    await expect(w.service.documentUrl(ctxs.staff1, e.equipmentId, label.documentId)).rejects.toMatchObject({ code: 'not_found' });
    expect((await w.service.documentUrl(ctxs.mgr, e.equipmentId, label.documentId)).url).toContain('memory://get/');
    expect(w.eq.audits.at(-1)).toMatchObject({ action: 'equipment.document_archive' });
    await expect(w.service.archiveDocument(ctxs.staff1, e.equipmentId, contract.documentId, { version: 4 })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('talep ve bakim baglantisi', () => {
  it('talep ekipmana baglanir; baska apartmanin ekipmani ve hizmetten cikmis ekipman reddedilir', async () => {
    const w = world();
    const e = await w.elevator();
    const foreign = (await w.service.create(ctxs.otherMgr, { name: 'Komşu asansör', category: 'elevator' })).equipment;
    const t = await w.ticket(ctxs.mgr, { equipmentId: e.equipmentId });
    expect(t).toHaveProperty('equipmentId', e.equipmentId);
    expect(w.fakeTickets.audits.at(-1)).toMatchObject({ action: 'ticket.create', details: { equipmentId: e.equipmentId } });
    // Kiraci izolasyonu: ayni kimlik bu apartmanin anahtarinda yok.
    await expect(w.ticket(ctxs.mgr, { equipmentId: foreign.equipmentId })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.ticket(ctxs.staff1, { equipmentId: 'bad#id' })).rejects.toBeInstanceOf(ValidationError);
    // Sakin ekipman secemez.
    await expect(w.ticket(ctxs.resident, { equipmentId: e.equipmentId, location: { kind: 'unit', unitId: 'u1' } })).rejects.toMatchObject({ code: 'forbidden' });
    // Eski kayitlar (ekipmansiz) aynen calisir.
    const plain = await w.ticket(ctxs.staff1);
    expect(plain).not.toHaveProperty('equipmentId');

    // Duzeltme: baglanti eklenir / kaldirilir; zaman cizelgesinde ic degisiklik olayi.
    const linked = await w.tickets.update(ctxs.mgr, plain.ticketId, { version: 1, equipmentId: e.equipmentId });
    expect(linked.ticket).toHaveProperty('equipmentId', e.equipmentId);
    expect((await w.tickets.list(ctxs.mgr, { equipmentId: e.equipmentId })).total).toBe(2);
    const cleared = await w.tickets.update(ctxs.mgr, plain.ticketId, { version: 2, equipmentId: null });
    expect(cleared.ticket).not.toHaveProperty('equipmentId');
    const events = (await w.tickets.get(ctxs.mgr, plain.ticketId)).events.filter((x) => x.kind === 'field_changed');
    expect(events.map((x) => ('changes' in x ? x.changes : undefined))).toEqual([{ equipmentId: [null, e.equipmentId] }, { equipmentId: [e.equipmentId, null] }]);
    await expect(w.tickets.update(ctxs.mgr, plain.ticketId, { version: 3, equipmentId: foreign.equipmentId })).rejects.toMatchObject({ code: 'not_found' });

    await w.service.setStatus(ctxs.mgr, e.equipmentId, { version: 1, status: 'retired', note: 'Söküldü' });
    await expect(w.ticket(ctxs.mgr, { equipmentId: e.equipmentId })).rejects.toMatchObject({ code: 'unprocessable' });
    // Var olan baglanti korunur (baska alan duzeltilebilir).
    expect((await w.tickets.update(ctxs.mgr, t.ticketId, { version: 1, priority: 'high' })).ticket).toHaveProperty('equipmentId', e.equipmentId);
  });

  it('bakim sablonu ekipmana baglanir, gorevlere kopyalanir; baglanti kaldirilinca baslamamis gorevlerden duser', async () => {
    const w = world();
    const e = await w.elevator();
    const foreign = (await w.service.create(ctxs.otherMgr, { name: 'Komşu asansör', category: 'elevator' })).equipment;
    const body = { preset: 'elevator_monthly', schedule: { startDate: TODAY }, equipmentId: e.equipmentId };
    await expect(w.maintenance.createTemplate(ctxs.mgr, { ...body, equipmentId: foreign.equipmentId })).rejects.toMatchObject({ code: 'not_found' });
    const { template } = await w.maintenance.createTemplate(ctxs.mgr, body);
    expect(template.equipmentId).toBe(e.equipmentId);
    const tasks = (await w.maintenance.listTasks(ctxs.mgr, { equipmentId: e.equipmentId })).items;
    expect(tasks.map((t) => [t.dueDate, t.equipmentId])).toEqual([
      ['2026-11-25', e.equipmentId],
      ['2026-12-25', e.equipmentId],
    ]);
    // Gorevden ariza: ekipman talebe gecer, yer ekipman adi.
    const opened = await w.maintenance.openTicket(ctxs.mgr, tasks[0]?.taskId as string, { idempotencyKey: 'mt-1' });
    expect(opened.ticket).toMatchObject({ equipmentId: e.equipmentId, source: 'maintenance', location: { kind: 'common', area: 'A Blok asansörü' } });

    await w.maintenance.updateTemplate(ctxs.mgr, template.templateId, { version: 1, equipmentId: null });
    const after = (await w.maintenance.listTasks(ctxs.mgr)).items;
    expect(after.every((t) => !('equipmentId' in t))).toBe(true);
    expect((await w.maintenance.getTemplate(ctxs.mgr, template.templateId)).template).not.toHaveProperty('equipmentId');
  });
});

describe('ekipman gecmisi', () => {
  it('bagli talepler ve gorevler, yil bazinda masraflar (ters kayit dusulur); gorevli masraf gormez', async () => {
    const w = world();
    const e = await w.elevator();
    const t1 = await w.ticket(ctxs.mgr, { equipmentId: e.equipmentId });
    await w.ticket(ctxs.mgr); // bagli degil
    // Masraflar workcosts ozetinden okunur (O1-4).
    const rec = w.fakeTickets.items.get(`APT#${APT}|TICKET#${t1.ticketId}`) as unknown as Ticket;
    rec.costSummary = {
      total: 300000,
      expenseIds: ['x1', 'x2', 'x3'],
      items: [
        { expenseId: 'x1', transactionId: 'tx1', amount: 100000, mode: 'expense', date: '2025-06-10', description: 'Kapı motoru', linkedAt: T0, linkedBy: 'mgr' },
        { expenseId: 'x2', transactionId: 'tx2', amount: 150000, mode: 'expense', date: '2026-02-01', description: 'Halat', linkedAt: T0, linkedBy: 'mgr' },
        { expenseId: 'x3', transactionId: 'tx3', amount: 50000, mode: 'link', date: '2026-03-01', description: 'Hatalı', linkedAt: T0, linkedBy: 'mgr' },
      ],
    };
    w.reversed.add('tx3');
    // Eski gorev: baglanti alani yok, sablon sonradan ekipmana baglandi -> gecmise sayilir.
    const { template } = await w.maintenance.createTemplate(ctxs.mgr, { preset: 'elevator_monthly', schedule: { startDate: '2026-10-25' }, defaultAssigneeId: 'staff-1' });
    const first = [...w.fakeMaint.items.values()].find((x): x is MaintenanceTask => x.entityType === 'MAINT_TASK') as MaintenanceTask;
    // v2 oncesi gorevde baglanti alani HIC yoktur (v2 gorevleri `null` dahil acikca yazar).
    const { equipmentId: _noLink, ...legacyBase } = first;
    expect(first.equipmentId).toBeNull();
    const legacy: MaintenanceTask = {
      ...legacyBase,
      PK: `APT#${APT}`,
      SK: `MTASK#2026-10-25#${template.templateId}`,
      taskId: `2026-10-25_${template.templateId}`,
      dueDate: '2026-10-25',
      status: 'done',
      completedAt: '2026-10-26T08:00:00.000Z',
      costSummary: { total: 40000, expenseIds: ['m1'], items: [{ expenseId: 'm1', transactionId: 'tm1', amount: 40000, mode: 'expense', date: '2026-10-26', description: 'Aylık bakım', linkedAt: T0, linkedBy: 'mgr' }] },
    };
    w.fakeMaint.items.set(legacy.SK, legacy);
    await w.maintenance.updateTemplate(ctxs.mgr, template.templateId, { version: 1, equipmentId: e.equipmentId });

    const h = await w.service.history(ctxs.mgr, e.equipmentId);
    // Ters kayit kontrolu tum gecmis icin tek toplu okuma.
    expect(w.reversedCalls).toEqual([['tx1', 'tx2', 'tx3', 'tm1']]);
    expect(h.counts).toEqual({ tickets: 1, openTickets: 1, maintenance: 3, maintenanceDone: 1 });
    expect(h.items.map((i) => [i.kind, i.date, i.status])).toEqual([
      ['maintenance', '2026-12-25', 'scheduled'],
      ['ticket', TODAY, 'open'],
      ['maintenance', TODAY, 'scheduled'],
      ['maintenance', '2026-10-26', 'done'],
    ]);
    expect(h.costs).toEqual({
      total: 290000,
      ticket: 250000,
      maintenance: 40000,
      byYear: [
        { year: '2026', total: 190000, ticket: 150000, maintenance: 40000, count: 2 },
        { year: '2025', total: 100000, ticket: 100000, maintenance: 0, count: 1 },
      ],
    });
    expect(h.items.find((i) => i.kind === 'ticket')).toMatchObject({ cost: 250000 });
    expect(h.templates).toEqual([{ templateId: template.templateId, name: 'Asansör aylık bakımı', schedule: { every: 1, unit: 'month', startDate: '2026-10-25' } }]);

    // Gorevli: masraf yok; yalnizca gorebildigi talep / gorevler (atanmamis acik talep havuzdadir).
    const staff = await w.service.history(ctxs.staff1, e.equipmentId);
    expect(staff).not.toHaveProperty('costs');
    expect(staff.items.every((i) => !('cost' in i) && !('costItems' in i))).toBe(true);
    expect(staff.items.map((i) => i.kind)).toEqual(['maintenance', 'ticket', 'maintenance', 'maintenance']);
    expect((await w.service.history(ctxs.staff2, e.equipmentId)).items.map((i) => i.kind)).toEqual(['ticket']);
    await w.tickets.assign(ctxs.mgr, t1.ticketId, { version: 1, assigneeId: 'staff-1' });
    expect((await w.service.history(ctxs.staff2, e.equipmentId)).items).toEqual([]);
    await expect(w.service.history(ctxs.otherMgr, e.equipmentId)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('gorevlinin tahmini tutar notu', () => {
  it('talebin gorevlisi girer (kurus, surumlu, denetimli, ic olay); yonetim gorur; sakin hicbir ucta goremez', async () => {
    const w = world();
    const t = await w.ticket(ctxs.resident, { location: { kind: 'unit', unitId: 'u1' }, category: 'plumbing', title: 'Musluk damlatıyor' });
    // Havuzdaki (atanmamis) talebi gorur ama tutar giremez.
    await expect(w.tickets.estimate(ctxs.staff1, t.ticketId, { version: 1, amount: 50000 })).rejects.toMatchObject({ code: 'forbidden' });
    await w.tickets.assign(ctxs.mgr, t.ticketId, { version: 1, assigneeId: 'staff-1' });
    expect((await w.tickets.get(ctxs.staff1, t.ticketId)).ticket).toMatchObject({ canEstimate: true });
    await expect(w.tickets.estimate(ctxs.staff1, t.ticketId, { version: 2, amount: 12.5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.tickets.estimate(ctxs.staff1, t.ticketId, { version: 1, amount: 50000 })).rejects.toMatchObject({ code: 'conflict' });
    const r = await w.tickets.estimate(ctxs.staff1, t.ticketId, { version: 2, amount: 125050, note: 'Conta ve işçilik' });
    expect(r.ticket).toMatchObject({ version: 3, estimate: { amount: 125050, note: 'Conta ve işçilik', by: 'staff-1', byRole: 'building_staff' } });
    expect(w.fakeTickets.audits.at(-1)).toMatchObject({ action: 'ticket.estimate', details: { amount: 125050, previous: null } });
    // Deftere / masraf ozetine hicbir sey yazilmaz.
    expect(r.ticket).not.toHaveProperty('costSummary');

    const mgrView = await w.tickets.get(ctxs.mgr, t.ticketId);
    expect(mgrView.ticket).toMatchObject({ estimate: { amount: 125050 } });
    expect(mgrView.events.find((e) => e.kind === 'estimate_set')).toMatchObject({ visibility: 'internal', amount: 125050, body: 'Conta ve işçilik' });
    expect((await w.tickets.get(ctxs.observer, t.ticketId)).ticket).toHaveProperty('estimate.amount', 125050);

    const residentView = await w.tickets.get(ctxs.resident, t.ticketId);
    expect(residentView.ticket).not.toHaveProperty('estimate');
    expect(residentView.ticket).not.toHaveProperty('canEstimate');
    expect(JSON.stringify(residentView)).not.toContain('125050');
    expect(JSON.stringify(await w.tickets.list(ctxs.resident))).not.toContain('125050');

    // Portal HTTP ucu da tasimaz.
    const app = createApp({
      version: 'test',
      ticketService: w.tickets,
      authenticate: (c) => {
        const raw = c.req.header('x-test-claims');
        return raw ? (JSON.parse(raw) as AuthClaims) : null;
      },
    });
    const portal = async (path: string) => {
      const res = await app.request(path, { headers: { 'x-test-claims': JSON.stringify({ userId: 'res', role: 'resident', apartmentId: APT }) } });
      return { status: res.status, text: await res.text() };
    };
    const detail = await portal(`/api/portal/tickets/${t.ticketId}`);
    expect(detail.status).toBe(200);
    expect(detail.text).not.toContain('estimate');
    expect(detail.text).not.toContain('125050');
    expect((await portal('/api/portal/tickets')).text).not.toContain('125050');

    // Baska gorevli giremez; kaldirma `null`; kapanan talepte degistirilemez.
    await w.tickets.assign(ctxs.mgr, t.ticketId, { version: 3, assigneeId: 'staff-2' });
    await expect(w.tickets.estimate(ctxs.staff1, t.ticketId, { version: 4, amount: 1 })).rejects.toMatchObject({ code: 'not_found' });
    const cleared = await w.tickets.estimate(ctxs.mgr, t.ticketId, { version: 4, amount: null });
    expect(cleared.ticket).not.toHaveProperty('estimate');
    await w.tickets.transition(ctxs.mgr, t.ticketId, { version: 5, action: 'cancel', note: 'Mükerrer kayıt' });
    await expect(w.tickets.estimate(ctxs.mgr, t.ticketId, { version: 6, amount: 1 })).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('bakim gorevi: gorevli kendi gorevine girer; baska gorevli ve atlanmis gorev reddedilir', async () => {
    const w = world();
    await w.maintenance.createTemplate(ctxs.mgr, { preset: 'water_pump', schedule: { startDate: TODAY }, defaultAssigneeId: 'staff-1' });
    const task = (await w.maintenance.listTasks(ctxs.mgr)).items[0];
    const id = task?.taskId as string;
    expect(task?.actions).toContain('estimate');
    await expect(w.maintenance.estimateTask(ctxs.staff2, id, { version: 1, amount: 1000 })).rejects.toMatchObject({ code: 'not_found' });
    const r = await w.maintenance.estimateTask(ctxs.staff1, id, { version: 1, amount: 75000, note: 'Pompa salmastrası' });
    expect(r.task).toMatchObject({ version: 2, estimate: { amount: 75000, note: 'Pompa salmastrası', by: 'staff-1' } });
    expect(w.fakeMaint.writes.at(-1)?.audit).toMatchObject({ action: 'maintenance.task_estimate', details: { amount: 75000, previous: null } });
    await expect(w.maintenance.estimateTask(ctxs.staff1, id, { version: 1, amount: 1 })).rejects.toMatchObject({ code: 'conflict' });
    await w.maintenance.skipTask(ctxs.mgr, id, { version: 2, reason: 'Firma gelmedi' });
    await expect(w.maintenance.estimateTask(ctxs.mgr, id, { version: 3, amount: 1 })).rejects.toMatchObject({ code: 'invalid_state' });
  });
});

describe('gunluk operasyon ozeti: ekipman tarihleri', () => {
  const digest = (payload: Partial<DomainEvent<'OPERATIONS_DIGEST'>['payload']>) =>
    buildEvent(
      {
        eventId: `OPS_DIGEST:${APT}:${TODAY}`,
        type: 'OPERATIONS_DIGEST',
        apartmentId: APT,
        actorId: 'system-scheduler',
        payload: { date: TODAY, slaBreached: [], maintenanceDue: [], maintenanceOverdue: [], autoClosed: 0, ...payload },
      },
      () => new Date(T0),
    ) as DomainEvent<'OPERATIONS_DIGEST'>;

  it('zamanlayici hatirlatmalari ozete ekler; yalnizca ekipman kalemi olan gunde de ozet yayinlanir', async () => {
    const w = world();
    const e = await w.elevator({ warrantyEndDate: '2026-12-10', serviceContractEndDate: '2026-11-01' });
    const events = createInMemoryEventPublisher();
    const worker = createSchedulerWorker({
      core: { listSiteIds: async () => [APT], getSite: async () => ({ siteId: APT, status: 'active', settings: defaultSiteSettings() }) as unknown as Site },
      finance: {} as never,
      plans: {} as never,
      payments: null,
      payouts: null,
      invoices: null,
      tickets: { runDaily: async () => ({ autoClosed: 0, conflicts: 0, breached: [] }) },
      maintenance: { generate: async () => ({ templates: 0, created: 0, existing: 0 }), digestItems: async () => ({ dueSoon: [], overdue: [] }) },
      equipment: w.service,
      events,
      now: () => new Date(T0),
      log: { info: () => {}, error: () => {} },
    });
    const out = await worker.runJob({ job: 'ticket_maintenance', scheduledTime: '2026-11-25T04:30:00Z' });
    expect(out[0]).toMatchObject({ status: 'done', detail: { equipmentExpiring: 2, digest: true } });
    expect(events.published[0]).toMatchObject({
      type: 'OPERATIONS_DIGEST',
      payload: {
        equipmentExpiring: [
          { equipmentId: e.equipmentId, name: 'A Blok asansörü', kind: 'contract', date: '2026-11-01', expired: true },
          { equipmentId: e.equipmentId, name: 'A Blok asansörü', kind: 'warranty', date: '2026-12-10', expired: false },
        ],
      },
    });
  });

  it('ekipman kalemleri yalnizca yonetime; e-postada ayri tablo ve konu ozeti', () => {
    const ev = digest({
      maintenanceDue: [{ taskId: 'm1', name: 'Hidrofor', dueDate: TODAY }],
      equipmentExpiring: [
        { equipmentId: 'e1', name: 'A Blok asansörü', kind: 'inspection', date: '2026-11-20', expired: true },
        { equipmentId: 'e2', name: 'Jeneratör', kind: 'warranty', date: '2026-12-10', expired: false },
      ],
    });
    const r = operationsDigestRecipients(ev, roles, TODAY);
    const by = Object.fromEntries(r.map((x) => [x.userId, x.data]));
    expect(by.mgr).toMatchObject({ equipmentCount: 2, dueCount: 1 });
    expect(by['staff-1']).toMatchObject({ equipmentCount: 0, dueCount: 1 });
    // Yalnizca ekipman kalemi varsa gorevliye e-posta gitmez.
    const onlyEquipment = operationsDigestRecipients(digest({ equipmentExpiring: [{ equipmentId: 'e1', name: 'Asansör', kind: 'contract', date: '2026-12-01', expired: false }] }), roles, TODAY);
    expect(onlyEquipment.map((x) => x.userId)).toEqual(['mgr']);
    // Eski olay (alan yok) aynen islenir.
    expect(operationsDigestRecipients(digest({ autoClosed: 1 }), roles, TODAY).map((x) => x.userId)).toEqual(['mgr']);

    const mail = renderEmail({ eventId: 'e', apartmentId: APT, userId: 'mgr', template: 'operations_digest', data: by.mgr ?? {} }, { siteName: 'Örnek Site', unitLabel: () => '', portalUrl: 'https://site.example/app' });
    expect(mail?.subject).toContain('2 ekipman tarihi yaklaştı veya doldu');
    expect(mail?.text).toContain('A Blok asansörü · Periyodik kontrol');
    expect(mail?.text).toContain('doldu 20.11.2026');
    expect(mail?.text).toContain('Jeneratör · Garanti');
  });
});

describe('API uclari', () => {
  it('roller, imzali belge linki, gecmis ve tahmini tutar uclari', async () => {
    const w = world();
    const app = createApp({
      version: 'test',
      ticketService: w.tickets,
      maintenanceService: w.maintenance,
      equipmentService: w.service,
      authenticate: (c) => {
        const raw = c.req.header('x-test-claims');
        return raw ? (JSON.parse(raw) as AuthClaims) : null;
      },
    });
    const call = async (method: string, path: string, ctx: EquipmentContext, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: { 'x-test-claims': JSON.stringify({ userId: ctx.userId, role: ctx.role, apartmentId: ctx.apartmentId }), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json()) as Record<string, any>, cache: res.headers.get('cache-control') };
    };
    const body = { name: 'Jeneratör', category: 'generator', warrantyEndDate: '2026-12-01' };
    expect((await call('POST', '/api/equipment', ctxs.staff1, body)).status).toBe(403);
    expect((await call('POST', '/api/equipment', ctxs.observer, body)).status).toBe(403);
    const created = await call('POST', '/api/equipment', ctxs.mgr, body);
    expect(created).toMatchObject({ status: 201, json: { equipment: { name: 'Jeneratör', status: 'active' } } });
    const id = created.json.equipment.equipmentId as string;
    const list = await call('GET', '/api/equipment?expiring=true', ctxs.staff1);
    expect(list).toMatchObject({ status: 200, cache: 'no-store', json: { total: 1, expiringCount: 1 } });
    expect((await call('GET', '/api/equipment', ctxs.resident)).status).toBe(403);
    expect((await call('GET', '/api/equipment', ctxs.guard)).status).toBe(403);
    expect((await call('GET', `/api/equipment/${id}`, ctxs.otherMgr)).status).toBe(404);
    expect((await call('PUT', `/api/equipment/${id}`, ctxs.mgr, { version: 9, name: 'X' })).status).toBe(409);
    expect((await call('POST', `/api/equipment/${id}/status`, ctxs.mgr, { version: 1, status: 'out_of_service', note: 'Akü' })).json.equipment.status).toBe('out_of_service');
    expect((await call('GET', '/api/equipment/expiring?days=10', ctxs.observer)).json.items).toHaveLength(1);
    expect((await call('GET', `/api/equipment/${id}/history`, ctxs.observer)).json).toMatchObject({ items: [], costs: { total: 0, byYear: [] } });
    expect((await call('POST', '/api/equipment/documents/upload-url', ctxs.staff1, { fileName: 'a.pdf', contentType: 'application/pdf', size: 10 })).status).toBe(403);
    const up = await call('POST', '/api/equipment/documents/upload-url', ctxs.mgr, { fileName: 'a.pdf', contentType: 'application/pdf', size: 10 });
    expect(up.json.uploadId).toMatch(/_pdf$/);

    // Tahmini tutar: sakin rolu yonetim ucunu kullanamaz.
    const t = await w.ticket(ctxs.mgr, { equipmentId: id });
    expect((await call('PUT', `/api/tickets/${t.ticketId}/estimate`, ctxs.resident, { version: 1, amount: 100 })).status).toBe(403);
    expect((await call('PUT', `/api/tickets/${t.ticketId}/estimate`, ctxs.observer, { version: 1, amount: 100 })).status).toBe(403);
    expect((await call('PUT', `/api/tickets/${t.ticketId}/estimate`, ctxs.mgr, { version: 1, amount: 100 })).json.ticket.estimate.amount).toBe(100);
    expect((await call('GET', `/api/tickets?equipmentId=${id}`, ctxs.mgr)).json.total).toBe(1);
  });
});

describe('inceleme duzeltmeleri', () => {
  const allOk = (task: { checklist: { id: string }[] }) => task.checklist.map((c) => ({ id: c.id, ok: true }));
  const raw = (w: ReturnType<typeof world>, taskId: string) => w.fakeMaint.items.get(`MTASK#${taskId.slice(0, 10)}#${taskId.slice(11)}`) as MaintenanceTask;

  it('gorev baglantisi acikca yazilir: yeniden baglama ve baglantisiz donem gecmisi tasimaz; filtre, gorunum, gecmis ve gorevden ariza ayni kurali kullanir', async () => {
    const w = world();
    const a = await w.elevator({ name: 'Asansör A' });
    const b = (await w.service.create(ctxs.mgr, { name: 'Asansör B', category: 'elevator' })).equipment;
    // Baglantisiz donem: sablon ekipmansiz; bugunku gorev tamamlanir.
    const { template } = await w.maintenance.createTemplate(ctxs.mgr, { preset: 'elevator_monthly', schedule: { startDate: TODAY } });
    const [t1, t2] = (await w.maintenance.listTasks(ctxs.mgr)).items;
    expect(raw(w, t1?.taskId as string).equipmentId).toBeNull();
    await w.maintenance.completeTask(ctxs.mgr, t1?.taskId as string, { version: 1, checklistResults: allOk(t1 as never) });
    // Sablon A'ya baglanir: yalnizca baslamamis gorev (12-25) A olur; tamamlanmis bugunku gorev baglantisiz kalir.
    await w.maintenance.updateTemplate(ctxs.mgr, template.templateId, { version: 1, equipmentId: a.equipmentId });
    expect(raw(w, t1?.taskId as string).equipmentId).toBeNull();
    expect(raw(w, t2?.taskId as string).equipmentId).toBe(a.equipmentId);
    await w.maintenance.completeTask(ctxs.mgr, t2?.taskId as string, { version: 2, checklistResults: allOk(t2 as never) });
    // v2 oncesi gorev (alan yok): sablonun GUNCEL baglantisina sayilir.
    const { equipmentId: _x, ...base } = raw(w, t1?.taskId as string);
    const legacy: MaintenanceTask = { ...base, SK: `MTASK#2026-10-25#${template.templateId}`, taskId: `2026-10-25_${template.templateId}`, dueDate: '2026-10-25' };
    w.fakeMaint.items.set(legacy.SK, legacy);
    // Yeniden baglama B: A'nin tamamlanmis gorevi A'da kalir.
    await w.maintenance.updateTemplate(ctxs.mgr, template.templateId, { version: 2, equipmentId: b.equipmentId });
    const ids = async (equipmentId: string) => (await w.service.history(ctxs.mgr, equipmentId)).items.map((i) => i.id);
    expect(await ids(a.equipmentId)).toEqual([t2?.taskId]);
    expect(await ids(b.equipmentId)).toEqual([legacy.taskId]);
    // Liste filtresi ve gorunum ayni kurali kullanir.
    const listed = async (equipmentId: string) => (await w.maintenance.listTasks(ctxs.mgr, { from: '2026-10-01', status: 'scheduled,in_progress,done', equipmentId })).items.map((t) => t.taskId);
    expect(await listed(a.equipmentId)).toEqual([t2?.taskId]);
    expect(await listed(b.equipmentId)).toEqual([legacy.taskId]);
    expect((await w.maintenance.getTask(ctxs.mgr, legacy.taskId)).task.equipmentId).toBe(b.equipmentId);
    expect((await w.maintenance.getTask(ctxs.mgr, t1?.taskId as string)).task).not.toHaveProperty('equipmentId');
    // Gorevden ariza: eski gorev B'ye, baglantisiz donemdeki gorev hicbir ekipmana baglanmaz.
    expect((await w.maintenance.openTicket(ctxs.mgr, legacy.taskId, { idempotencyKey: 'leg-1' })).ticket).toHaveProperty('equipmentId', b.equipmentId);
    expect((await w.maintenance.openTicket(ctxs.mgr, t1?.taskId as string, { idempotencyKey: 'unl-1' })).ticket).not.toHaveProperty('equipmentId');
    // Zamanlayicinin yeni gorevi B'yi acikca tasir.
    w.setNow('2026-12-20T06:00:00.000Z');
    await w.maintenance.generate(APT, '2026-12-20');
    expect(raw(w, `2027-01-25_${template.templateId}`).equipmentId).toBe(b.equipmentId);
  });

  it('hizmetten cikan ekipman: yeni gorev ve gorevden ariza baglanmaz, sablon baglantisi gecmis icin kalir; durum yaniti bagli aktif sablonlari doner', async () => {
    const w = world();
    const e = await w.elevator();
    const { template } = await w.maintenance.createTemplate(ctxs.mgr, { preset: 'elevator_monthly', schedule: { startDate: TODAY }, equipmentId: e.equipmentId });
    const [t1] = (await w.maintenance.listTasks(ctxs.mgr)).items;
    const r = await w.service.setStatus(ctxs.mgr, e.equipmentId, { version: 1, status: 'retired', note: 'Söküldü' });
    expect(r.linkedTemplates).toEqual([{ templateId: template.templateId, name: 'Asansör aylık bakımı' }]);
    expect(r.warning).toContain('1 aktif bakım şablonu');
    expect(w.eq.audits.at(-1)).toMatchObject({ action: 'equipment.status', details: { linkedTemplates: [template.templateId] } });
    // Zamanlayici yeni gorevi baglamaz; sablon baglantisi korunur.
    w.setNow('2026-12-20T06:00:00.000Z');
    await w.maintenance.generate(APT, '2026-12-20');
    expect(raw(w, `2027-01-25_${template.templateId}`).equipmentId).toBeNull();
    expect((await w.maintenance.getTemplate(ctxs.mgr, template.templateId)).template.equipmentId).toBe(e.equipmentId);
    // Eski baglantili gorevden acilan ariza hizmet disi ekipmana baglanmaz.
    expect((await w.maintenance.openTicket(ctxs.mgr, t1?.taskId as string, { idempotencyKey: 'ret-1' })).ticket).not.toHaveProperty('equipmentId');
    // Gecmis korunur.
    expect((await w.service.history(ctxs.mgr, e.equipmentId)).items.map((i) => i.id)).toContain(t1?.taskId);
  });

  it('tedarikci carisi: degismeyen pasif cari duzenlemeyi engellemez; cari degisince ad yeni cariden gelir', async () => {
    const w = world();
    w.accounts.push({ accountId: 'sup-kuzey', name: 'Kuzey Servis', type: 'payable', status: 'active' } as Account);
    const e = await w.elevator({ serviceCompany: { supplierAccountId: 'sup-asansor', phone: '0212 555 00 00' } });
    expect(e.serviceCompany?.name).toBe('Yıldız Asansör Ltd.');
    // Cari Finans'ta pasife alindi: ayni cariyle baska alanlar duzenlenebilir (web her alani gonderir).
    (w.accounts.find((a) => a.accountId === 'sup-asansor') as Account).status = 'inactive' as never;
    const kept = await w.service.update(ctxs.mgr, e.equipmentId, { version: 1, notes: 'Anahtar yönetimde', serviceCompany: { supplierAccountId: 'sup-asansor', name: 'Yıldız Asansör Ltd.', phone: '0212 555 00 00' } });
    expect(kept.equipment).toMatchObject({ notes: 'Anahtar yönetimde', serviceCompany: { supplierAccountId: 'sup-asansor' } });
    // Yeni cari: ad acikca verilmediyse yeni carinin adi.
    const switched = await w.service.update(ctxs.mgr, e.equipmentId, { version: 2, serviceCompany: { supplierAccountId: 'sup-kuzey' } });
    expect(switched.equipment.serviceCompany).toEqual({ supplierAccountId: 'sup-kuzey', name: 'Kuzey Servis', phone: '0212 555 00 00' });
    const named = await w.service.update(ctxs.mgr, e.equipmentId, { version: 3, serviceCompany: { supplierAccountId: 'sup-asansor', name: 'Elle ad' } }).catch((err: unknown) => err);
    expect(named).toBeInstanceOf(ValidationError);
    const explicit = await w.service.update(ctxs.mgr, e.equipmentId, { version: 3, serviceCompany: { supplierAccountId: null, name: 'Bağımsız servis' } });
    expect(explicit.equipment.serviceCompany).toEqual({ name: 'Bağımsız servis', phone: '0212 555 00 00' });
  });

  it('gorevli yaniti: tedarikci cari kimligi ve bakim gorevi masraf ozeti yok', async () => {
    const w = world();
    const e = await w.elevator({ serviceCompany: { supplierAccountId: 'sup-asansor' } });
    const staff = (await w.service.get(ctxs.staff1, e.equipmentId)).equipment;
    expect(staff.serviceCompany).toEqual({ name: 'Yıldız Asansör Ltd.' });
    expect((await w.service.list(ctxs.staff1)).items[0]?.serviceCompany).not.toHaveProperty('supplierAccountId');
    expect((await w.service.get(ctxs.observer, e.equipmentId)).equipment.serviceCompany).toHaveProperty('supplierAccountId', 'sup-asansor');

    await w.maintenance.createTemplate(ctxs.mgr, { preset: 'water_pump', schedule: { startDate: TODAY }, defaultAssigneeId: 'staff-1' });
    const [task] = (await w.maintenance.listTasks(ctxs.mgr)).items;
    const id = task?.taskId as string;
    raw(w, id).costSummary = { total: 75000, expenseIds: ['x1'] };
    expect((await w.maintenance.getTask(ctxs.mgr, id)).task).toHaveProperty('costSummary.total', 75000);
    expect((await w.maintenance.getTask(ctxs.observer, id)).task).toHaveProperty('costSummary');
    expect((await w.maintenance.getTask(ctxs.staff1, id)).task).not.toHaveProperty('costSummary');
    expect(JSON.stringify(await w.maintenance.listTasks(ctxs.staff1))).not.toContain('costSummary');
    expect(JSON.stringify(await w.maintenance.calendar(ctxs.staff1, { month: '2026-11' }))).not.toContain('costSummary');
  });

  it('gunluk ozet: her gun 30 gun ileri / geri; uzun suredir dolmus sozlesme ve kontrol yalnizca pazartesi', async () => {
    const w = world();
    await w.elevator({ warrantyEndDate: '2026-12-10', serviceContractEndDate: '2026-06-01', nextInspectionDate: '2026-11-10' });
    const wed = await w.service.digestItems(APT, '2026-11-25');
    expect(wed.weekly).toBe(false);
    expect(wed.items.map((i) => i.kind)).toEqual(['inspection', 'warranty']);
    const mon = await w.service.digestItems(APT, '2026-11-30');
    expect(mon.weekly).toBe(true);
    expect(mon.items.map((i) => [i.kind, i.expired])).toEqual([
      ['contract', true],
      ['inspection', true],
      ['warranty', false],
    ]);
    // Yonetim ekrani tam listeyi her gun gosterir.
    expect((await w.service.expiring(ctxs.mgr)).items.map((i) => i.kind)).toEqual(['contract', 'inspection', 'warranty']);
  });

  it('ozet olayi 100 kalemle sinirli; sayi ve konu kesilmeden onceki toplam, pazartesi basligi', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ equipmentId: `e${i}`, name: `Ekipman ${i}`, kind: 'contract' as const, date: '2026-12-01', expired: false }));
    const events = createInMemoryEventPublisher();
    const worker = createSchedulerWorker({
      core: { listSiteIds: async () => [APT], getSite: async () => ({ siteId: APT, status: 'active', settings: defaultSiteSettings() }) as unknown as Site },
      finance: {} as never,
      plans: {} as never,
      payments: null,
      payouts: null,
      invoices: null,
      tickets: { runDaily: async () => ({ autoClosed: 0, conflicts: 0, breached: [] }) },
      maintenance: { generate: async () => ({ templates: 0, created: 0, existing: 0 }), digestItems: async () => ({ dueSoon: [], overdue: [] }) },
      equipment: { digestItems: async () => ({ items: many, weekly: true }) },
      events,
      now: () => new Date('2026-11-30T06:00:00.000Z'),
      log: { info: () => {}, error: () => {} },
    });
    const out = await worker.runJob({ job: 'ticket_maintenance', scheduledTime: '2026-11-30T04:30:00Z' });
    expect(out[0]).toMatchObject({ detail: { equipmentExpiring: 120 } });
    const ev = events.published[0] as DomainEvent<'OPERATIONS_DIGEST'>;
    expect(ev.payload.equipmentExpiring).toHaveLength(100);
    expect(ev.payload).toMatchObject({ equipmentTotal: 120, equipmentWeekly: true });
    const [mgr] = operationsDigestRecipients(ev, roles, '2026-11-30');
    expect(mgr?.data).toMatchObject({ equipmentCount: 120 });
    const mail = renderEmail({ eventId: 'e', apartmentId: APT, userId: 'mgr', template: 'operations_digest', data: mgr?.data ?? {} }, { siteName: 'Örnek', unitLabel: () => '', portalUrl: 'https://site.example/app' });
    expect(mail?.subject).toContain('120 ekipman tarihi yaklaştı veya doldu');
    expect(mail?.html).toContain('haftalık tam liste');
    expect(mail?.text).toContain('Listenin tamamı yönetim panelinde.');
  });

  it('tahmini tutar: guncel gorevli; acan gorevli yalnizca talep atanmamisken; guvenlik hicbir yanitta gormez', async () => {
    const w = world();
    const t = await w.ticket(ctxs.staff1);
    // Atanmamis: acan gorevli girebilir.
    expect((await w.tickets.estimate(ctxs.staff1, t.ticketId, { version: 1, amount: 10000 })).ticket).toHaveProperty('estimate.amount', 10000);
    await w.tickets.assign(ctxs.mgr, t.ticketId, { version: 2, assigneeId: 'staff-2' });
    // Baskasina atandi: acan gorevli artik giremez (talebi gormeye devam eder), atanan girer.
    expect((await w.tickets.get(ctxs.staff1, t.ticketId)).ticket).toMatchObject({ canEstimate: false });
    await expect(w.tickets.estimate(ctxs.staff1, t.ticketId, { version: 3, amount: 1 })).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('güncel görevlisi') });
    expect((await w.tickets.estimate(ctxs.staff2, t.ticketId, { version: 3, amount: 20000 })).ticket).toHaveProperty('estimate.amount', 20000);

    // Guvenlik: kendi actigi talepte bile tahmini tutar donmez.
    const g = await w.ticket(ctxs.guard, { title: 'Bariyer açılmıyor' });
    await w.tickets.estimate(ctxs.mgr, g.ticketId, { version: 1, amount: 55500, note: 'Motor' });
    const guardView = JSON.stringify([await w.tickets.get(ctxs.guard, g.ticketId), await w.tickets.list(ctxs.guard)]);
    expect(guardView).not.toContain('55500');
    expect(guardView).not.toContain('estimate');
    expect(guardView).not.toContain('canEstimate');
  });

  it('ad cozumleme: ids= durumdan bagimsiz; en fazla 100 kimlik', async () => {
    const w = world();
    const a = await w.elevator();
    const b = (await w.service.create(ctxs.mgr, { name: 'Eski jeneratör', category: 'generator' })).equipment;
    await w.service.setStatus(ctxs.mgr, b.equipmentId, { version: 1, status: 'retired', note: 'Satıldı' });
    expect((await w.service.list(ctxs.mgr)).items.map((e) => e.name)).toEqual(['A Blok asansörü']);
    expect((await w.service.list(ctxs.staff1, { ids: `${a.equipmentId},${b.equipmentId}` })).items.map((e) => [e.name, e.status])).toEqual([
      ['A Blok asansörü', 'active'],
      ['Eski jeneratör', 'retired'],
    ]);
    await expect(w.service.list(ctxs.mgr, { ids: Array.from({ length: 101 }, (_, i) => `x${i}`).join(',') })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.service.list(ctxs.mgr, { ids: 'bad#id' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('gecmis: talep satiri Istanbul gunu; varsayilan son 5 yil, years 1-10', async () => {
    const w = world();
    const e = await w.elevator();
    w.setNow('2020-03-10T09:00:00.000Z');
    const old = await w.ticket(ctxs.mgr, { equipmentId: e.equipmentId, title: 'Eski arıza' });
    w.setNow('2026-11-25T22:30:00.000Z'); // Istanbul 26.11.2026 01:30
    const late = await w.ticket(ctxs.mgr, { equipmentId: e.equipmentId });
    const h = await w.service.history(ctxs.mgr, e.equipmentId);
    expect(h).toMatchObject({ years: 5, from: '2021-11-27' });
    expect(h.items.map((i) => [i.id, i.date])).toEqual([[late.ticketId, '2026-11-26']]);
    expect((await w.service.history(ctxs.mgr, e.equipmentId, { years: '10' })).items.map((i) => i.id)).toEqual([late.ticketId, old.ticketId]);
    await expect(w.service.history(ctxs.mgr, e.equipmentId, { years: '11' })).rejects.toBeInstanceOf(ValidationError);
  });
});
