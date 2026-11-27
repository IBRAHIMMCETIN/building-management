/**
 * Ariza & bakim v2 - Ekipman sicili servisi: kayit, duzenleme, durum (silme yok), belgeler (private
 * S3, imzali URL), arama / filtreler, son tarih hatirlatmalari ve ekipman gecmisi (bagli talepler,
 * bakim gorevleri ve masraflari).
 *
 * Yetki: yonetici / yonetim firmasi yazar; denetci ve bina gorevlisi okur. Gorevli masraflari ve
 * ticari sartli belgeleri (servis sozlesmesi) gormez; gecmiste yalnizca gorebildigi talep ve
 * gorevler listelenir (talep / bakim modullerindeki kurallarla ayni). Sakin ve guvenlik bu ekrani
 * kullanmaz.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { CoreRepository } from '../core/repository.js';
import { coreRepository } from '../core/repository.js';
import type { IsoDate } from '../core/types.js';
import { type Obj, ValidationError, asObject, assertId, isIsoDate, optString, reqEnum, reqInt, reqString } from '../core/validation.js';
import { INVOICE_CONTENT_TYPES, MAX_INVOICE_BYTES, contentDisposition, isInvoiceContentType, safeFileName } from '../documents/keys.js';
import { type DocumentStore, URL_TTL_SECONDS, createDocumentStoreFromEnv } from '../documents/store.js';
import type { FinanceRepository } from '../finance/repository.js';
import { financeRepository } from '../finance/repository.js';
import type { FinanceService } from '../finance/service.js';
import { type MaintenanceRepository, maintenanceRepository } from '../maintenance/repository.js';
import { addDays } from '../maintenance/schedule.js';
import { type MaintenanceTask, OPEN_TASK_STATUSES } from '../maintenance/types.js';
import { TicketError } from '../tickets/errors.js';
import { actorKindOf, canView } from '../tickets/model.js';
import { type TicketRepository, ticketRepository } from '../tickets/repository.js';
import { ticketSettingsOf } from '../tickets/service.js';
import { ACTIVE_STATUSES, type Ticket } from '../tickets/types.js';
import type { CostSummary } from '../workcosts/types.js';
import { EXPIRY_WINDOW_DAYS, daysBetween, expiryItems, expiryItemsOf } from './expiry.js';
import { EquipmentConflictError, type EquipmentRepository, equipmentRepository } from './repository.js';
import {
  DOCUMENT_KINDS,
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_STATUSES,
  type Equipment,
  type EquipmentDocument,
  type EquipmentStatus,
  INSPECTION_LABELS,
  MANAGER_ONLY_DOCUMENT_KINDS,
  MAX_DOCUMENTS_PER_EQUIPMENT,
  type ServiceCompany,
  equipmentDocumentKeys,
  equipmentKeys,
} from './types.js';

export type EquipmentContext = { apartmentId: string; userId: string; role: string };

export type EquipmentServiceDeps = {
  repo: EquipmentRepository;
  core: Pick<CoreRepository, 'getBlock' | 'getSite'>;
  accounts: Pick<FinanceRepository, 'getAccount'>;
  tickets: Pick<TicketRepository, 'list'>;
  maintenance: Pick<MaintenanceRepository, 'listTemplates' | 'listTasks'>;
  /** Masraf iptal (ters kayit) kontrolu; verilmezse masraflar yazildigi haliyle sayilir. */
  finance?: Pick<FinanceService, 'isReversed'>;
  store: DocumentStore | undefined;
  now: () => Date;
  newId: () => string;
};

type Kind = 'manager' | 'staff' | 'observer';

/** Gecmis penceresi: bugunden geriye 10 yil, ileriye 60 gun (planli bakimlar). */
const HISTORY_YEARS = 10;
const HISTORY_AHEAD_DAYS = 60;
const MAX_PAGE = 200;
const UPLOAD_ID = /^[a-f0-9]{24}_(pdf|jpg|png|webp|heic)$/;
const PHONE = /^[0-9+()\s-]{5,30}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Duzenlenebilir alanlar (denetim kaydinda degisen alan listesi). */
const EDITABLE_FIELDS = [
  'name',
  'category',
  'blockId',
  'location',
  'brand',
  'model',
  'serialNumber',
  'installDate',
  'warrantyEndDate',
  'serviceCompany',
  'serviceContractEndDate',
  'lastInspectionDate',
  'nextInspectionDate',
  'inspectionLabel',
  'notes',
] as const satisfies readonly (keyof Equipment)[];

export function createEquipmentService(overrides: Partial<EquipmentServiceDeps> = {}) {
  const deps: EquipmentServiceDeps = {
    repo: equipmentRepository,
    core: coreRepository,
    accounts: financeRepository,
    tickets: ticketRepository,
    maintenance: maintenanceRepository,
    store: 'store' in overrides ? overrides.store : createDocumentStoreFromEnv(),
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.repo;
  const stamp = () => deps.now().toISOString();
  const today = (): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());
  const expiresAt = () => new Date(deps.now().getTime() + URL_TTL_SECONDS * 1000).toISOString();

  // -------------------------------------------------------------------------
  // Yardimcilar
  // -------------------------------------------------------------------------

  function kindOf(ctx: EquipmentContext): Kind {
    const k = actorKindOf(ctx.role);
    if (k === 'manager' || k === 'staff' || k === 'observer') return k;
    throw new TicketError('forbidden', 'Ekipman sicilini bu rol kullanamaz');
  }
  function requireManager(ctx: EquipmentContext) {
    if (kindOf(ctx) !== 'manager') throw new TicketError('forbidden', 'Ekipman sicilini yalnızca yönetim düzenleyebilir');
  }
  function requireStore(): DocumentStore {
    if (!deps.store) throw new TicketError('unavailable', 'Belge deposu yapılandırılmamış (DOCUMENTS_BUCKET)');
    return deps.store;
  }

  async function load(ctx: EquipmentContext, equipmentId: string): Promise<Equipment> {
    assertId(equipmentId, 'equipmentId');
    const e = await repo.get(ctx.apartmentId, equipmentId);
    if (!e || e.apartmentId !== ctx.apartmentId) throw new TicketError('not_found', 'Ekipman bulunamadı');
    return e;
  }

  async function write(apartmentId: string, w: Parameters<EquipmentRepository['write']>[1]) {
    try {
      await repo.write(apartmentId, w);
    } catch (err) {
      if (err instanceof EquipmentConflictError) throw new TicketError('conflict', err.message);
      throw err;
    }
  }

  function guardVersion(e: Equipment, o: Obj) {
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    if (e.version !== version) throw new TicketError('conflict', 'Ekipman kaydı başka bir işlemle değişti; sayfayı yenileyin');
    return version;
  }

  const seesDocument = (kind: Kind, d: EquipmentDocument) => kind !== 'staff' || (d.status === 'active' && !MANAGER_ONLY_DOCUMENT_KINDS.includes(d.kind));

  function documentView({ key: _key, ...d }: EquipmentDocument) {
    return d;
  }

  function view(ctx: EquipmentContext, e: Equipment) {
    const kind = kindOf(ctx);
    const { PK: _pk, SK: _sk, documents, ...rest } = e;
    const visible = documents.filter((d) => seesDocument(kind, d));
    return {
      ...rest,
      documents: visible.map(documentView),
      documentCount: visible.filter((d) => d.status === 'active').length,
      expiry: expiryItemsOf(e, today()),
      canEdit: kind === 'manager',
    };
  }

  // -------------------------------------------------------------------------
  // Girdi
  // -------------------------------------------------------------------------

  const text = (o: Obj, key: string, max: number, current?: string, min = 1): string | undefined => {
    if (o[key] === undefined) return current;
    if (o[key] === null || o[key] === '') return undefined;
    return reqString(o, key, max, min);
  };
  const date = (o: Obj, key: string, current?: IsoDate): IsoDate | undefined => {
    if (o[key] === undefined) return current;
    if (o[key] === null || o[key] === '') return undefined;
    if (typeof o[key] !== 'string' || !isIsoDate(o[key] as string)) throw new ValidationError(`${key} YYYY-AA-GG olmalı`, key);
    return o[key] as IsoDate;
  };

  async function parseServiceCompany(ctx: EquipmentContext, value: unknown, current?: ServiceCompany): Promise<ServiceCompany | undefined> {
    if (value === undefined) return current;
    if (value === null) return undefined;
    const o = asObject(value, 'serviceCompany');
    let supplierAccountId = current?.supplierAccountId;
    let supplierName: string | undefined;
    if (o.supplierAccountId !== undefined) {
      if (o.supplierAccountId === null || o.supplierAccountId === '') supplierAccountId = undefined;
      else {
        const id = assertId(o.supplierAccountId, 'serviceCompany.supplierAccountId');
        const acc = await deps.accounts.getAccount(ctx.apartmentId, id);
        if (!acc || acc.type !== 'payable' || acc.status !== 'active') {
          throw new ValidationError('serviceCompany.supplierAccountId aktif bir tedarikçi hesabı olmalı', 'serviceCompany.supplierAccountId');
        }
        supplierAccountId = id;
        supplierName = acc.name;
      }
    }
    const name = text(o, 'name', 120, current?.name, 2) ?? supplierName;
    const phone = text(o, 'phone', 30, current?.phone);
    if (phone && !PHONE.test(phone)) throw new ValidationError('serviceCompany.phone geçerli bir telefon numarası olmalı', 'serviceCompany.phone');
    const email = text(o, 'email', 120, current?.email);
    if (email && !EMAIL.test(email)) throw new ValidationError('serviceCompany.email geçerli bir e-posta adresi olmalı', 'serviceCompany.email');
    const out: ServiceCompany = {
      ...(supplierAccountId ? { supplierAccountId } : {}),
      ...(name ? { name } : {}),
      ...(phone ? { phone } : {}),
      ...(email ? { email } : {}),
    };
    return Object.keys(out).length ? out : undefined;
  }

  /** Tam girdi (olusturma) veya `base` uzerine kismi girdi (duzenleme). */
  async function parseInput(ctx: EquipmentContext, o: Obj, base?: Equipment) {
    const name = o.name === undefined && base ? base.name : reqString(o, 'name', 120, 2);
    const category = o.category === undefined && base ? base.category : reqEnum(o, 'category', EQUIPMENT_CATEGORIES);
    let blockId = base?.blockId;
    if (o.blockId !== undefined) {
      if (o.blockId === null || o.blockId === '') blockId = undefined;
      else {
        const id = assertId(o.blockId, 'blockId');
        if (id !== base?.blockId) {
          const b = await deps.core.getBlock(ctx.apartmentId, id);
          if (!b || b.status !== 'active') throw new TicketError('not_found', 'Blok bulunamadı');
        }
        blockId = id;
      }
    }
    const installDate = date(o, 'installDate', base?.installDate);
    const warrantyEndDate = date(o, 'warrantyEndDate', base?.warrantyEndDate);
    if (installDate && warrantyEndDate && warrantyEndDate < installDate) throw new ValidationError('Garanti bitişi kurulum tarihinden önce olamaz', 'warrantyEndDate');
    const lastInspectionDate = date(o, 'lastInspectionDate', base?.lastInspectionDate);
    const nextInspectionDate = date(o, 'nextInspectionDate', base?.nextInspectionDate);
    if (lastInspectionDate && nextInspectionDate && nextInspectionDate < lastInspectionDate) {
      throw new ValidationError('Sonraki kontrol tarihi son kontrol tarihinden önce olamaz', 'nextInspectionDate');
    }
    const inspectionLabel =
      o.inspectionLabel === undefined ? base?.inspectionLabel : o.inspectionLabel === null || o.inspectionLabel === '' ? undefined : reqEnum(o, 'inspectionLabel', INSPECTION_LABELS);
    const fields = {
      location: text(o, 'location', 120, base?.location),
      brand: text(o, 'brand', 80, base?.brand),
      model: text(o, 'model', 80, base?.model),
      serialNumber: text(o, 'serialNumber', 80, base?.serialNumber),
      installDate,
      warrantyEndDate,
      serviceCompany: await parseServiceCompany(ctx, o.serviceCompany, base?.serviceCompany),
      serviceContractEndDate: date(o, 'serviceContractEndDate', base?.serviceContractEndDate),
      lastInspectionDate,
      nextInspectionDate,
      inspectionLabel,
      notes: text(o, 'notes', 2000, base?.notes),
    };
    const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<typeof fields>;
    return { name, category, ...(blockId ? { blockId } : {}), ...defined };
  }

  // -------------------------------------------------------------------------
  // Kayit
  // -------------------------------------------------------------------------

  async function create(ctx: EquipmentContext, body: unknown) {
    requireManager(ctx);
    const o = asObject(body);
    const input = await parseInput(ctx, o);
    const ts = stamp();
    const equipmentId = deps.newId().replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
    const item: Equipment = {
      ...equipmentKeys.equipment(ctx.apartmentId, equipmentId),
      entityType: 'EQUIPMENT',
      apartmentId: ctx.apartmentId,
      equipmentId,
      ...input,
      status: 'active',
      documents: [],
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    await write(ctx.apartmentId, {
      item,
      expectedVersion: 0,
      audit: { apartmentId: ctx.apartmentId, action: 'equipment.create', target: { type: 'equipment', id: equipmentId }, details: { name: item.name, category: item.category, ...(item.serialNumber ? { serialNumber: item.serialNumber } : {}) } },
    });
    return { equipment: view(ctx, item) };
  }

  async function update(ctx: EquipmentContext, equipmentId: string, body: unknown) {
    requireManager(ctx);
    const o = asObject(body);
    const current = await load(ctx, equipmentId);
    const version = guardVersion(current, o);
    const input = await parseInput(ctx, o, current);
    const ts = stamp();
    const next: Equipment = {
      ...equipmentKeys.equipment(ctx.apartmentId, equipmentId),
      entityType: 'EQUIPMENT',
      apartmentId: ctx.apartmentId,
      equipmentId,
      ...input,
      status: current.status,
      ...(current.statusNote ? { statusNote: current.statusNote } : {}),
      ...(current.statusChangedAt ? { statusChangedAt: current.statusChangedAt } : {}),
      documents: current.documents,
      createdAt: current.createdAt,
      createdBy: current.createdBy,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: version + 1,
    };
    const fields = EDITABLE_FIELDS.filter((k) => JSON.stringify(current[k]) !== JSON.stringify(next[k]));
    if (!fields.length) return { equipment: view(ctx, current) };
    await write(ctx.apartmentId, {
      item: next,
      expectedVersion: version,
      audit: { apartmentId: ctx.apartmentId, action: 'equipment.update', target: { type: 'equipment', id: equipmentId }, details: { name: next.name, fields } },
    });
    return { equipment: view(ctx, next) };
  }

  /** Durum: calisiyor / devre disi / hizmetten cikarildi. Hizmetten cikarma gerekceli. */
  async function setStatus(ctx: EquipmentContext, equipmentId: string, body: unknown) {
    requireManager(ctx);
    const o = asObject(body);
    const current = await load(ctx, equipmentId);
    const version = guardVersion(current, o);
    const status = reqEnum(o, 'status', EQUIPMENT_STATUSES) as EquipmentStatus;
    const note = optString(o, 'note', 500)?.trim() || undefined;
    if (status === 'retired' && (!note || note.length < 3)) throw new ValidationError('Hizmetten çıkarma için açıklama gerekli (en az 3 karakter)', 'note');
    if (status === current.status) return { equipment: view(ctx, current) };
    const ts = stamp();
    const { statusNote: _n, ...rest } = current;
    const next: Equipment = { ...rest, status, ...(note ? { statusNote: note } : {}), statusChangedAt: ts, updatedAt: ts, updatedBy: ctx.userId, version: version + 1 };
    await write(ctx.apartmentId, {
      item: next,
      expectedVersion: version,
      audit: { apartmentId: ctx.apartmentId, action: 'equipment.status', target: { type: 'equipment', id: equipmentId }, ...(note ? { reason: note } : {}), details: { name: current.name, from: current.status, to: status } },
    });
    return { equipment: view(ctx, next) };
  }

  // -------------------------------------------------------------------------
  // Okuma
  // -------------------------------------------------------------------------

  /**
   * Liste. Filtreler: `q` (ad, marka, model, seri no, konum), `category`, `status` (varsayilan
   * hizmette olanlar: active + out_of_service; `all` hepsi), `blockId`, `warrantyWithin=N`
   * (garantisi bugun .. +N gun icinde bitenler), `expiring=true` (hatirlatmasi olanlar).
   */
  async function list(ctx: EquipmentContext, q: Record<string, string | undefined> = {}) {
    kindOf(ctx);
    if (q.category && !(EQUIPMENT_CATEGORIES as readonly string[]).includes(q.category)) throw new ValidationError('category geçersiz', 'category');
    if (q.status && q.status !== 'all' && !(EQUIPMENT_STATUSES as readonly string[]).includes(q.status)) throw new ValidationError('status geçersiz', 'status');
    let warrantyWithin: number | undefined;
    if (q.warrantyWithin !== undefined && q.warrantyWithin !== '') {
      warrantyWithin = Number(q.warrantyWithin);
      if (!Number.isSafeInteger(warrantyWithin) || warrantyWithin < 0 || warrantyWithin > 3650) throw new ValidationError('warrantyWithin 0-3650 gün olmalı', 'warrantyWithin');
    }
    const d = today();
    const term = q.q?.trim().toLocaleLowerCase('tr');
    const limit = q.limit ? Math.min(Math.max(Number(q.limit) || 100, 1), MAX_PAGE) : 100;
    const offset = q.cursor ? Math.max(Number(q.cursor) || 0, 0) : 0;
    const all = await repo.list(ctx.apartmentId);
    const inService = all.filter((e) => e.status !== 'retired');
    const items = all
      .filter((e) => (q.status === 'all' ? true : q.status ? e.status === q.status : e.status !== 'retired'))
      .filter((e) => !q.category || e.category === q.category)
      .filter((e) => !q.blockId || e.blockId === q.blockId)
      .filter((e) => warrantyWithin === undefined || (!!e.warrantyEndDate && e.warrantyEndDate >= d && daysBetween(d, e.warrantyEndDate) <= warrantyWithin))
      .filter((e) => q.expiring !== 'true' || expiryItemsOf(e, d).length > 0)
      .filter((e) => !term || [e.name, e.brand, e.model, e.serialNumber, e.location].some((v) => v?.toLocaleLowerCase('tr').includes(term)))
      .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    const page = items.slice(offset, offset + limit);
    return {
      items: page.map((e) => view(ctx, e)),
      total: items.length,
      ...(offset + limit < items.length ? { nextCursor: String(offset + limit) } : {}),
      /** Rozet: hizmetteki ekipmanin hatirlatma kalemi sayisi (filtreden bagimsiz). */
      expiringCount: expiryItems(inService, d).length,
    };
  }

  /** Son tarih hatirlatmalari: onumuzdeki `days` gun (varsayilan 30) + tarihi gecenler. */
  async function expiring(ctx: EquipmentContext, q: { days?: string } = {}) {
    kindOf(ctx);
    const days = q.days === undefined || q.days === '' ? EXPIRY_WINDOW_DAYS : Number(q.days);
    if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new ValidationError('days 1-365 olmalı', 'days');
    return { days, items: expiryItems(await repo.list(ctx.apartmentId), today(), days) };
  }

  async function get(ctx: EquipmentContext, equipmentId: string) {
    kindOf(ctx);
    return { equipment: view(ctx, await load(ctx, equipmentId)) };
  }

  /** Zamanlayici: gunluk operasyon ozeti icin hatirlatma kalemleri (yalnizca yonetime gider). */
  async function digestItems(apartmentId: string, day: IsoDate) {
    return expiryItems(await repo.list(apartmentId), day, EXPIRY_WINDOW_DAYS).map(({ daysLeft: _d, ...i }) => i);
  }

  // -------------------------------------------------------------------------
  // Gecmis: talepler, bakim gorevleri, masraflar
  // -------------------------------------------------------------------------

  async function liveCosts(ctx: EquipmentContext, summary: CostSummary | undefined) {
    const items = summary?.items ?? [];
    return Promise.all(
      items.map(async (i) => ({
        date: i.date,
        amount: i.amount,
        description: i.description,
        expenseId: i.expenseId,
        reversed: deps.finance ? await deps.finance.isReversed(ctx, i.transactionId) : false,
      })),
    );
  }

  /**
   * Ekipmana bagli talepler (`Ticket.equipmentId`) ve bakim gorevleri. Gorev, olustugu andaki
   * baglantiyi (`MaintenanceTask.equipmentId`) tasir; baglanti alani olmayan eski gorevler
   * sablonun guncel ekipmanina sayilir (ekipman sonradan baglandiginda gecmis de gorunsun).
   * Masraflar (yonetim + denetci) Finans'taki ters kayitlar dusulerek yil bazinda toplanir.
   */
  async function history(ctx: EquipmentContext, equipmentId: string) {
    const kind = kindOf(ctx);
    const e = await load(ctx, equipmentId);
    const d = today();
    const seesCosts = kind !== 'staff';
    const [tickets, templates, tasks, site] = await Promise.all([
      deps.tickets.list(ctx.apartmentId),
      deps.maintenance.listTemplates(ctx.apartmentId),
      deps.maintenance.listTasks(ctx.apartmentId, addDays(d, -365 * HISTORY_YEARS), addDays(d, HISTORY_AHEAD_DAYS)),
      deps.core.getSite(ctx.apartmentId),
    ]);
    const settings = ticketSettingsOf(site);
    const actor = { apartmentId: ctx.apartmentId, userId: ctx.userId, role: ctx.role, kind, unitIds: [] as string[] };
    const templateEquipment = new Map(templates.map((t) => [t.templateId, t.equipmentId]));
    const linkedTickets = tickets.filter((t: Ticket) => t.equipmentId === equipmentId && canView(actor, t, settings));
    const taskEquipment = (t: MaintenanceTask) => ('equipmentId' in t ? t.equipmentId : templateEquipment.get(t.templateId));
    const staffSees = (t: MaintenanceTask) => kind !== 'staff' || t.assigneeId === ctx.userId || (settings.staffSelfAssign && !t.assigneeId && OPEN_TASK_STATUSES.includes(t.status));
    const linkedTasks = tasks.filter((t) => t.status !== 'cancelled' && taskEquipment(t) === equipmentId && staffSees(t));

    type Row = Record<string, unknown> & { kind: 'ticket' | 'maintenance'; id: string; date: IsoDate };
    const rows: Row[] = [];
    const costs: { year: string; amount: number; kind: 'ticket' | 'maintenance' }[] = [];
    for (const t of linkedTickets) {
      const live = seesCosts ? await liveCosts(ctx, t.costSummary) : [];
      for (const c of live) if (!c.reversed) costs.push({ year: c.date.slice(0, 4), amount: c.amount, kind: 'ticket' });
      rows.push({
        kind: 'ticket',
        id: t.ticketId,
        date: t.createdAt.slice(0, 10),
        number: t.number,
        title: t.title,
        status: t.status,
        priority: t.priority,
        active: ACTIVE_STATUSES.includes(t.status),
        ...(t.resolvedAt ? { resolvedAt: t.resolvedAt } : {}),
        ...(t.estimate ? { estimate: t.estimate.amount } : {}),
        ...(seesCosts ? { cost: live.filter((c) => !c.reversed).reduce((s, c) => s + c.amount, 0), costItems: live } : {}),
      });
    }
    for (const t of linkedTasks) {
      const live = seesCosts ? await liveCosts(ctx, t.costSummary) : [];
      for (const c of live) if (!c.reversed) costs.push({ year: c.date.slice(0, 4), amount: c.amount, kind: 'maintenance' });
      rows.push({
        kind: 'maintenance',
        id: t.taskId,
        date: t.completedAt ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date(t.completedAt)) : t.dueDate,
        title: t.name,
        dueDate: t.dueDate,
        status: t.status,
        templateId: t.templateId,
        upcoming: OPEN_TASK_STATUSES.includes(t.status) && t.dueDate >= d,
        overdue: OPEN_TASK_STATUSES.includes(t.status) && t.dueDate < d,
        ...(t.estimate ? { estimate: t.estimate.amount } : {}),
        ...(seesCosts ? { cost: live.filter((c) => !c.reversed).reduce((s, c) => s + c.amount, 0), costItems: live } : {}),
      });
    }
    rows.sort((a, b) => b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id)));

    const years = [...new Set(costs.map((c) => c.year))].sort().reverse();
    const total = (xs: typeof costs) => xs.reduce((s, c) => s + c.amount, 0);
    return {
      equipmentId,
      name: e.name,
      items: rows,
      counts: {
        tickets: linkedTickets.length,
        openTickets: linkedTickets.filter((t) => ACTIVE_STATUSES.includes(t.status)).length,
        maintenance: linkedTasks.length,
        maintenanceDone: linkedTasks.filter((t) => t.status === 'done').length,
      },
      templates: templates
        .filter((t) => t.equipmentId === equipmentId && t.status === 'active')
        .map((t) => ({ templateId: t.templateId, name: t.name, schedule: t.schedule })),
      ...(seesCosts
        ? {
            costs: {
              total: total(costs),
              ticket: total(costs.filter((c) => c.kind === 'ticket')),
              maintenance: total(costs.filter((c) => c.kind === 'maintenance')),
              byYear: years.map((year) => {
                const ys = costs.filter((c) => c.year === year);
                return { year, total: total(ys), ticket: total(ys.filter((c) => c.kind === 'ticket')), maintenance: total(ys.filter((c) => c.kind === 'maintenance')), count: ys.length };
              }),
            },
          }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Belgeler (private S3, imzali URL)
  // -------------------------------------------------------------------------

  /** 1. adim: tarayicidan dogrudan yukleme linki (tur ve boyut imzalanir; anahtar kullaniciya bagli). */
  async function documentUploadUrl(ctx: EquipmentContext, body: unknown) {
    requireManager(ctx);
    const store = requireStore();
    const o = asObject(body);
    const fileName = safeFileName(reqString(o, 'fileName', 255), 'belge');
    if (!isInvoiceContentType(o.contentType)) throw new TicketError('unprocessable', 'Desteklenmeyen dosya türü. İzin verilenler: PDF, JPEG, PNG, WEBP, HEIC');
    const size = reqInt(o, 'size', 1, Number.MAX_SAFE_INTEGER);
    if (size > MAX_INVOICE_BYTES) throw new TicketError('unprocessable', 'Belge en fazla 10 MB olabilir');
    const uploadId = `${randomBytes(12).toString('hex')}_${INVOICE_CONTENT_TYPES[o.contentType]}`;
    const uploadUrl = await store.presignPut(equipmentDocumentKeys.pending(ctx.apartmentId, ctx.userId, uploadId), {
      contentType: o.contentType,
      contentLength: size,
      expiresIn: URL_TTL_SECONDS,
    });
    return { uploadId, fileName, uploadUrl, method: 'PUT' as const, headers: { 'Content-Type': o.contentType }, maxBytes: MAX_INVOICE_BYTES, expiresAt: expiresAt() };
  }

  /**
   * 2. adim: gecici dosya dogrulanir (gercek nesnenin turu / boyutu), kalici anahtara kopyalanir ve
   * belge kaydi ekipmana surumle eklenir. Kopya kayittan once yapilir; yazim basarisiz olursa
   * dosya sahipsiz kalir (zararsiz).
   */
  async function addDocument(ctx: EquipmentContext, equipmentId: string, body: unknown) {
    requireManager(ctx);
    const o = asObject(body);
    const current = await load(ctx, equipmentId);
    const version = guardVersion(current, o);
    const uploadId = o.uploadId;
    if (typeof uploadId !== 'string' || !UPLOAD_ID.test(uploadId)) throw new ValidationError('uploadId geçersiz', 'uploadId');
    const kind = reqEnum(o, 'kind', DOCUMENT_KINDS);
    const fileName = safeFileName(reqString(o, 'fileName', 255), 'belge');
    const title = (optString(o, 'title', 120)?.trim() || fileName).slice(0, 120);
    const validUntil = date(o, 'validUntil');
    if (current.documents.filter((d) => d.status === 'active').length >= MAX_DOCUMENTS_PER_EQUIPMENT) {
      throw new TicketError('unprocessable', `Bir ekipmana en fazla ${MAX_DOCUMENTS_PER_EQUIPMENT} belge eklenebilir; eskileri arşivleyin`);
    }
    const store = requireStore();
    const tmp = equipmentDocumentKeys.pending(ctx.apartmentId, ctx.userId, uploadId);
    const head = await store.head(tmp);
    if (!head) throw new TicketError('unprocessable', 'Belge yüklenmemiş veya süresi dolmuş; yeniden yükleyin');
    if (head.size > MAX_INVOICE_BYTES) throw new TicketError('unprocessable', 'Belge en fazla 10 MB olabilir');
    if (!isInvoiceContentType(head.contentType)) throw new TicketError('unprocessable', 'Desteklenmeyen dosya türü');
    const documentId = deps.newId().replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
    const key = equipmentDocumentKeys.final(ctx.apartmentId, equipmentId, documentId, INVOICE_CONTENT_TYPES[head.contentType]);
    await store.copy(tmp, key);
    const ts = stamp();
    const doc: EquipmentDocument = {
      documentId,
      kind,
      title,
      fileName,
      contentType: head.contentType,
      size: head.size,
      key,
      ...(validUntil ? { validUntil } : {}),
      uploadedAt: ts,
      uploadedBy: ctx.userId,
      status: 'active',
    };
    const next: Equipment = { ...current, documents: [...current.documents, doc], updatedAt: ts, updatedBy: ctx.userId, version: version + 1 };
    await write(ctx.apartmentId, {
      item: next,
      expectedVersion: version,
      audit: { apartmentId: ctx.apartmentId, action: 'equipment.document_add', target: { type: 'equipment', id: equipmentId }, details: { name: current.name, documentId, kind, title } },
    });
    return { equipment: view(ctx, next), document: documentView(doc) };
  }

  /** Belge silinmez: arsivlenir (yonetim ve denetci gormeye devam eder). */
  async function archiveDocument(ctx: EquipmentContext, equipmentId: string, documentId: string, body: unknown) {
    requireManager(ctx);
    const o = asObject(body);
    const current = await load(ctx, equipmentId);
    const version = guardVersion(current, o);
    assertId(documentId, 'documentId');
    const doc = current.documents.find((d) => d.documentId === documentId);
    if (!doc) throw new TicketError('not_found', 'Belge bulunamadı');
    if (doc.status === 'archived') return { equipment: view(ctx, current) };
    const ts = stamp();
    const next: Equipment = {
      ...current,
      documents: current.documents.map((d) => (d.documentId === documentId ? { ...d, status: 'archived' as const, archivedAt: ts, archivedBy: ctx.userId } : d)),
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: version + 1,
    };
    await write(ctx.apartmentId, {
      item: next,
      expectedVersion: version,
      audit: { apartmentId: ctx.apartmentId, action: 'equipment.document_archive', target: { type: 'equipment', id: equipmentId }, details: { name: current.name, documentId, kind: doc.kind, title: doc.title } },
    });
    return { equipment: view(ctx, next) };
  }

  /** Imzali goruntuleme linki (5 dk). Gorevli sozlesme ve arsivlenmis belgeyi acamaz. */
  async function documentUrl(ctx: EquipmentContext, equipmentId: string, documentId: string) {
    const kind = kindOf(ctx);
    const e = await load(ctx, equipmentId);
    assertId(documentId, 'documentId');
    const doc = e.documents.find((d) => d.documentId === documentId);
    if (!doc || !seesDocument(kind, doc)) throw new TicketError('not_found', 'Belge bulunamadı');
    const store = requireStore();
    const url = await store.presignGet(doc.key, { contentDisposition: contentDisposition(doc.fileName, 'inline'), contentType: doc.contentType, expiresIn: URL_TTL_SECONDS });
    return { url, fileName: doc.fileName, contentType: doc.contentType, expiresAt: expiresAt() };
  }

  return { create, update, setStatus, list, expiring, get, history, digestItems, documentUploadUrl, addDocument, archiveDocument, documentUrl };
}

export type EquipmentService = ReturnType<typeof createEquipmentService>;
