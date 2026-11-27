/**
 * Faz 3 (O1-3) - Periyodik bakim servisi: hazir sablonlar, sablon yonetimi, gorev uretimi (API'de
 * sablon kaydedilince ve her gun `maintenance_tasks` isiyle), gorev akisi (atama, baslatma,
 * kontrol listesiyle tamamlama, atlama), gorevden ariza acma, takvim ve gunluk ozet kalemleri.
 *
 * Yetki: yonetici / firma her sey; bina gorevlisi kendisine atanan ve (ayar acikken) atanmamis
 * gorevleri gorur, kendine ustlenir, baslatir ve tamamlar; denetci salt okunur. Sakin ve guvenlik
 * bakim ekranini kullanmaz.
 *
 * Takvim penceresi: bugun .. bugun + leadDays + 30 gun. Gorev anahtari (vade + sablon) ayni gunun
 * ikinci kez uretilmesini engeller; is tekrar calissa da zararsizdir. Sablon degisince baslamamis
 * gelecek gorevler yeni takvime gore guncellenir; artik istenmeyenler `cancelled` olur (silme yok).
 */
import { randomUUID } from 'node:crypto';
import { type ApartmentRoleRepository, apartmentRoleRepository } from '../apartment-roles/repository.js';
import type { CoreRepository } from '../core/repository.js';
import { coreRepository } from '../core/repository.js';
import type { IsoDate } from '../core/types.js';
import { type Obj, ValidationError, asObject, assertId, isIsoDate, optString, reqEnum, reqInt, reqString } from '../core/validation.js';
import { type DocumentStore, createDocumentStoreFromEnv } from '../documents/store.js';
import { type EquipmentLookup, resolveEquipmentLink } from '../equipment/links.js';
import { equipmentRepository } from '../equipment/repository.js';
import type { FinanceRepository } from '../finance/repository.js';
import { financeRepository } from '../finance/repository.js';
import { MAX_AMOUNT } from '../finance/service.js';
import { TicketError } from '../tickets/errors.js';
import { actorKindOf } from '../tickets/model.js';
import { parseUploadIds, photoIdOf, ticketPhotos } from '../tickets/photos.js';
import type { TicketService } from '../tickets/service.js';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, type TicketSettings } from '../tickets/types.js';
import { MAINTENANCE_PRESETS, presetOf } from './presets.js';
import { MaintenanceConflictError, type MaintenanceRepository, maintenanceRepository } from './repository.js';
import { addDays, addMonthsClamped, occurrences } from './schedule.js';
import {
  type ChecklistItem,
  type ChecklistResult,
  type MaintenanceTask,
  type MaintenanceTemplate,
  OPEN_TASK_STATUSES,
  SCHEDULE_UNITS,
  TASK_STATUSES,
  type TaskStatus,
  maintenanceKeys,
  parseTaskId,
  taskEquipmentId,
  taskIdOf,
} from './types.js';

export type MaintenanceContext = { apartmentId: string; userId: string; role: string };

/**
 * Gorev listesinin varsayilan geriye bakma penceresi (gun). Genel Bakis'in "geciken bakim" sayisi
 * (`/tasks?status=open&overdue=true`) ve yonetim portfoyu ayni pencereyi kullanir: ayni sayi.
 */
export const TASK_LIST_LOOKBACK_DAYS = 90;

export type MaintenanceServiceDeps = {
  repo: MaintenanceRepository;
  tickets: Pick<TicketService, 'create' | 'settingsOf'>;
  roles: Pick<ApartmentRoleRepository, 'list'>;
  core: Pick<CoreRepository, 'getBlock'>;
  accounts: Pick<FinanceRepository, 'getAccount'>;
  /** v2: ekipman sicili (sablon baglantisi dogrulamasi, gorevden ariza yeri). */
  equipment: EquipmentLookup;
  store: DocumentStore | undefined;
  now: () => Date;
  newId: () => string;
};

/** Gorev uretim penceresi: sablonun on hazirlik suresine ek olarak. */
export const GENERATION_HORIZON_DAYS = 30;
/** Gunluk ozette "yaklasan" sayilan gun sayisi (bugun dahil). */
export const DUE_SOON_DAYS = 3;
const MAX_CHECKLIST = 30;
const MAX_TASKS_PER_WRITE = 60;

type Kind = 'manager' | 'staff' | 'observer';

export function createMaintenanceService(overrides: Partial<MaintenanceServiceDeps> & Pick<MaintenanceServiceDeps, 'tickets'>) {
  const deps: MaintenanceServiceDeps = {
    repo: maintenanceRepository,
    roles: apartmentRoleRepository,
    core: coreRepository,
    accounts: financeRepository,
    equipment: equipmentRepository,
    store: 'store' in overrides ? overrides.store : createDocumentStoreFromEnv(),
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.repo;
  const photos = ticketPhotos(deps.store, () => deps.now());
  const stamp = () => deps.now().toISOString();
  const today = (): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());

  // -------------------------------------------------------------------------
  // Yardimcilar
  // -------------------------------------------------------------------------

  function kindOf(ctx: MaintenanceContext): Kind {
    const k = actorKindOf(ctx.role);
    if (k === 'manager' || k === 'staff' || k === 'observer') return k;
    throw new TicketError('forbidden', 'Bakım ekranını bu rol kullanamaz');
  }
  function requireManager(ctx: MaintenanceContext) {
    if (kindOf(ctx) !== 'manager') throw new TicketError('forbidden', 'Bu işlemi yalnızca yönetim yapabilir');
  }

  async function activeStaff(apartmentId: string) {
    const d = today();
    return (await deps.roles.list(apartmentId))
      .filter((r) => r.role === 'building_staff' && r.status === 'active' && r.startDate <= d && (!r.endDate || r.endDate >= d))
      .map((r) => r.userId);
  }

  async function write(apartmentId: string, w: Parameters<MaintenanceRepository['write']>[1]) {
    try {
      await repo.write(apartmentId, w);
    } catch (err) {
      if (err instanceof MaintenanceConflictError) throw new TicketError('conflict', err.message);
      throw err;
    }
  }

  const window = (t: Pick<MaintenanceTemplate, 'leadDays'>, from = today()) => ({ from, to: addDays(from, t.leadDays + GENERATION_HORIZON_DAYS) });

  /**
   * v2: yeni / uyarlanan gorevin ekipman baglantisi (her gorevde acikca yazilir). Sablonun ekipmani
   * hizmetten cikmissa ya da yoksa `null`: sablonun baglantisi gecmis icin kalir ama yeni gorev
   * (ve ondan acilan ariza) hizmet disi ekipmana baglanmaz. `cache` ayni calismada tekrar okumayi onler.
   */
  async function linkFor(t: Pick<MaintenanceTemplate, 'apartmentId' | 'equipmentId'>, cache?: Map<string, string | null>): Promise<string | null> {
    if (!t.equipmentId) return null;
    const hit = cache?.get(t.equipmentId);
    if (hit !== undefined) return hit;
    const e = await deps.equipment.get(t.apartmentId, t.equipmentId);
    const link = e && e.apartmentId === t.apartmentId && e.status !== 'retired' ? e.equipmentId : null;
    cache?.set(t.equipmentId, link);
    return link;
  }

  function newTask(t: MaintenanceTemplate, dueDate: IsoDate, actor: string, ts: string, link: string | null): MaintenanceTask {
    return {
      ...maintenanceKeys.task(t.apartmentId, dueDate, t.templateId),
      entityType: 'MAINT_TASK',
      apartmentId: t.apartmentId,
      taskId: taskIdOf(dueDate, t.templateId),
      templateId: t.templateId,
      templateVersion: t.version,
      dueDate,
      ...snapshotOf(t, link),
      status: 'scheduled',
      ...(t.defaultAssigneeId ? { assigneeId: t.defaultAssigneeId } : {}),
      ticketIds: [],
      createdAt: ts,
      createdBy: actor,
      updatedAt: ts,
      updatedBy: actor,
      version: 1,
    };
  }

  /** Gorevin sablondan kopyalanan alanlari (`link`: `linkFor` sonucu, `null` dahil acikca yazilir). */
  function snapshotOf(t: MaintenanceTemplate, link: string | null) {
    return {
      name: t.name,
      kind: t.kind,
      category: t.category,
      ...(t.asset ? { asset: t.asset } : {}),
      equipmentId: link,
      ...(t.blockIds?.length ? { blockIds: t.blockIds } : {}),
      checklist: t.checklist,
    };
  }

  // -------------------------------------------------------------------------
  // Sablon girdisi
  // -------------------------------------------------------------------------

  function parseChecklist(value: unknown): ChecklistItem[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_CHECKLIST) throw new ValidationError(`checklist en fazla ${MAX_CHECKLIST} maddelik bir dizi olmalı`, 'checklist');
    return value.map((raw, i) => {
      if (typeof raw === 'string') {
        const text = raw.trim();
        if (text.length < 2 || text.length > 200) throw new ValidationError(`checklist[${i}] 2-200 karakter olmalı`, 'checklist');
        return { id: `c${i + 1}`, text, required: true };
      }
      const o = asObject(raw, `checklist[${i}]`);
      return { id: `c${i + 1}`, text: reqString(o, 'text', 200, 2).trim(), required: o.required === undefined ? true : o.required === true };
    });
  }

  async function parseAccount(apartmentId: string, value: unknown, field: string, type: 'payable' | 'expense'): Promise<string | undefined> {
    if (value === undefined || value === null || value === '') return undefined;
    const id = assertId(value, field);
    const acc = await deps.accounts.getAccount(apartmentId, id);
    if (!acc || acc.type !== type || acc.status !== 'active') {
      throw new ValidationError(`${field} aktif bir ${type === 'payable' ? 'tedarikçi' : 'gider'} hesabı olmalı`, field);
    }
    return id;
  }

  /** Tam girdi (olusturma) veya `base` uzerine kismi girdi (duzenleme). */
  async function parseTemplateInput(ctx: MaintenanceContext, o: Obj, base?: MaintenanceTemplate) {
    const preset = base ? undefined : o.preset === undefined ? undefined : presetOf(String(o.preset));
    if (!base && o.preset !== undefined && !preset) throw new ValidationError('Bilinmeyen hazır şablon', 'preset');
    const pick = <T>(key: string, parse: () => T, fallback: T | undefined): T => {
      if (o[key] !== undefined) return parse();
      if (fallback === undefined) throw new ValidationError(`${key} zorunlu`, key);
      return fallback;
    };
    const name = pick('name', () => reqString(o, 'name', 120, 2).trim(), base?.name ?? preset?.name);
    const category = pick('category', () => reqEnum(o, 'category', TICKET_CATEGORIES), base?.category ?? preset?.category);
    const s = o.schedule === undefined ? undefined : asObject(o.schedule, 'schedule');
    const every = s?.every !== undefined ? reqInt(s, 'every', 1, 52) : (base?.schedule.every ?? preset?.every);
    const unit = s?.unit !== undefined ? reqEnum(s, 'unit', SCHEDULE_UNITS) : (base?.schedule.unit ?? preset?.unit);
    const startDate = s?.startDate !== undefined ? reqString(s, 'startDate', 10) : base?.schedule.startDate;
    if (!every || !unit || !startDate) throw new ValidationError('schedule.every, schedule.unit ve schedule.startDate zorunlu', 'schedule');
    if (!isIsoDate(startDate)) throw new ValidationError('schedule.startDate YYYY-MM-DD olmalı', 'schedule.startDate');
    const checklist = o.checklist !== undefined ? parseChecklist(o.checklist) : (base?.checklist ?? parseChecklist(preset?.checklist));

    let blockIds = base?.blockIds;
    if (o.blockIds !== undefined) {
      if (o.blockIds === null) blockIds = undefined;
      else {
        if (!Array.isArray(o.blockIds) || o.blockIds.length > 50) throw new ValidationError('blockIds en fazla 50 öğeli bir dizi olmalı', 'blockIds');
        const ids = [...new Set(o.blockIds.map((v, i) => assertId(v, `blockIds[${i}]`)))];
        for (const id of ids) {
          const b = await deps.core.getBlock(ctx.apartmentId, id);
          if (!b || b.status !== 'active') throw new TicketError('not_found', `Blok bulunamadı: ${id}`);
        }
        blockIds = ids.length ? ids.sort() : undefined;
      }
    }
    let defaultAssigneeId = base?.defaultAssigneeId;
    if (o.defaultAssigneeId !== undefined) {
      if (o.defaultAssigneeId === null || o.defaultAssigneeId === '') defaultAssigneeId = undefined;
      else {
        const id = assertId(o.defaultAssigneeId, 'defaultAssigneeId');
        if (!(await activeStaff(ctx.apartmentId)).includes(id)) throw new TicketError('unprocessable', 'Varsayılan görevli bu apartmanın aktif bina görevlisi değil');
        defaultAssigneeId = id;
      }
    }
    const optText = (key: string, max: number, current?: string) => (o[key] === undefined ? current : o[key] === null || o[key] === '' ? undefined : optString(o, key, max)?.trim());
    const supplierAccountId = o.supplierAccountId === undefined ? base?.supplierAccountId : await parseAccount(ctx.apartmentId, o.supplierAccountId, 'supplierAccountId', 'payable');
    const expenseAccountId =
      o.expenseAccountId === undefined
        ? (base?.expenseAccountId ?? (preset?.expenseAccountId ? await parseAccount(ctx.apartmentId, preset.expenseAccountId, 'expenseAccountId', 'expense').catch(() => undefined) : undefined))
        : await parseAccount(ctx.apartmentId, o.expenseAccountId, 'expenseAccountId', 'expense');
    const expectedCost = o.expectedCost === undefined ? base?.expectedCost : o.expectedCost === null ? undefined : reqInt(o, 'expectedCost', 0, MAX_AMOUNT);
    const leadDays = o.leadDays === undefined ? (base?.leadDays ?? 7) : reqInt(o, 'leadDays', 0, 60);
    const asset = optText('asset', 120, base?.asset);
    const legalNote = optText('legalNote', 500, base?.legalNote ?? preset?.legalNote);
    const { equipmentId } = await resolveEquipmentLink(deps.equipment, ctx.apartmentId, o.equipmentId, base?.equipmentId);
    return {
      name,
      kind: base?.kind ?? preset?.preset ?? 'custom',
      category,
      ...(asset ? { asset } : {}),
      ...(equipmentId ? { equipmentId } : {}),
      ...(blockIds ? { blockIds } : {}),
      schedule: { every, unit, startDate },
      checklist,
      ...(defaultAssigneeId ? { defaultAssigneeId } : {}),
      ...(supplierAccountId ? { supplierAccountId } : {}),
      ...(expenseAccountId ? { expenseAccountId } : {}),
      ...(expectedCost !== undefined ? { expectedCost } : {}),
      ...(legalNote ? { legalNote } : {}),
      leadDays,
    };
  }

  // -------------------------------------------------------------------------
  // Sablonlar
  // -------------------------------------------------------------------------

  const templateView = ({ PK: _pk, SK: _sk, ...t }: MaintenanceTemplate) => t;

  function presets(ctx: MaintenanceContext) {
    kindOf(ctx);
    return { items: MAINTENANCE_PRESETS };
  }

  async function listTemplates(ctx: MaintenanceContext, q: { status?: string } = {}) {
    kindOf(ctx);
    const all = await repo.listTemplates(ctx.apartmentId);
    const status = q.status ?? 'active';
    return {
      items: all
        .filter((t) => status === 'all' || t.status === status)
        .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
        .map(templateView),
    };
  }

  async function loadTemplate(ctx: MaintenanceContext, templateId: string) {
    assertId(templateId, 'templateId');
    const t = await repo.getTemplate(ctx.apartmentId, templateId);
    if (!t) throw new TicketError('not_found', 'Bakım şablonu bulunamadı');
    return t;
  }

  async function getTemplate(ctx: MaintenanceContext, templateId: string) {
    kindOf(ctx);
    const t = await loadTemplate(ctx, templateId);
    const { from, to } = window(t);
    const upcoming = (await repo.listTasks(ctx.apartmentId, from, to)).filter((x) => x.templateId === templateId && x.status !== 'cancelled');
    return { template: templateView(t), upcoming: upcoming.map((x) => taskView(x, ctx, undefined, t)) };
  }

  /** Yeni sablon; penceredeki gorevler ayni atomik yazimda olusur. */
  async function createTemplate(ctx: MaintenanceContext, body: unknown) {
    requireManager(ctx);
    const o = asObject(body);
    const input = await parseTemplateInput(ctx, o);
    const ts = stamp();
    const templateId = deps.newId().replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
    const template: MaintenanceTemplate = {
      ...maintenanceKeys.template(ctx.apartmentId, templateId),
      entityType: 'MAINT_TEMPLATE',
      apartmentId: ctx.apartmentId,
      templateId,
      ...input,
      status: 'active',
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    const { from, to } = window(template);
    const link = await linkFor(template);
    const tasks = occurrences(template.schedule, from, to, MAX_TASKS_PER_WRITE).map((d) => ({ item: newTask(template, d, ctx.userId, ts, link), expectedVersion: 0 }));
    await write(ctx.apartmentId, {
      at: ts,
      template: { item: template, expectedVersion: 0 },
      tasks,
      audit: { apartmentId: ctx.apartmentId, action: 'maintenance.template_create', target: { type: 'maintenance_template', id: templateId }, details: { name: template.name, kind: template.kind, schedule: template.schedule } },
    });
    return { template: templateView(template), generated: tasks.length };
  }

  /**
   * Sablon duzenleme. Baslamamis (`scheduled`) gelecek gorevler yeni takvime uyarlanir: istenen
   * tarihteki gorevin kopya alanlari ve (eski varsayilana atanmissa) gorevlisi guncellenir, artik
   * istenmeyen tarih `cancelled` olur, sablon degisikligiyle iptal edilmis ama yeniden istenen tarih
   * geri alinir, yeni tarih olusturulur. Baslamis / bitmis gorevlere dokunulmaz.
   */
  async function updateTemplate(ctx: MaintenanceContext, templateId: string, body: unknown) {
    requireManager(ctx);
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await loadTemplate(ctx, templateId);
    if (current.status !== 'active') throw new TicketError('invalid_state', 'Arşivlenmiş şablon düzenlenemez');
    if (current.version !== version) throw new TicketError('conflict', 'Şablon başka bir işlemle değişti; sayfayı yenileyin');
    const input = await parseTemplateInput(ctx, o, current);
    const ts = stamp();
    const next: MaintenanceTemplate = {
      ...maintenanceKeys.template(ctx.apartmentId, templateId),
      entityType: 'MAINT_TEMPLATE',
      apartmentId: ctx.apartmentId,
      templateId,
      ...input,
      status: 'active',
      createdAt: current.createdAt,
      createdBy: current.createdBy,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: version + 1,
    };
    const tasks = await reconcileTasks(ctx, current, next, ts);
    await write(ctx.apartmentId, {
      at: ts,
      template: { item: next, expectedVersion: version },
      tasks,
      audit: { apartmentId: ctx.apartmentId, action: 'maintenance.template_update', target: { type: 'maintenance_template', id: templateId }, details: { name: next.name, schedule: next.schedule, tasksChanged: tasks.length } },
    });
    return { template: templateView(next), tasksChanged: tasks.length };
  }

  async function reconcileTasks(ctx: MaintenanceContext, prev: MaintenanceTemplate, next: MaintenanceTemplate | undefined, ts: string) {
    const from = today();
    const to = addDays(from, Math.max(prev.leadDays, next?.leadDays ?? 0) + GENERATION_HORIZON_DAYS);
    const existing = (await repo.listTasks(ctx.apartmentId, from, to)).filter((t) => t.templateId === prev.templateId);
    const desired = next ? new Set(occurrences(next.schedule, from, addDays(from, next.leadDays + GENERATION_HORIZON_DAYS), MAX_TASKS_PER_WRITE)) : new Set<IsoDate>();
    const out: { item: MaintenanceTask; expectedVersion: number }[] = [];
    const touch = (t: MaintenanceTask) => ({ updatedAt: ts, updatedBy: ctx.userId, version: t.version + 1 });
    const link = next ? await linkFor(next) : null;
    for (const t of existing) {
      const wanted = desired.has(t.dueDate);
      desired.delete(t.dueDate);
      if (t.status === 'scheduled' && !wanted) {
        out.push({ item: { ...t, status: 'cancelled', cancelReason: next ? 'Şablon takvimi değişti' : 'Şablon arşivlendi', ...touch(t) }, expectedVersion: t.version });
      } else if (next && wanted && (t.status === 'scheduled' || (t.status === 'cancelled' && !!t.cancelReason))) {
        const keepAssignee = t.assigneeId && t.assigneeId !== prev.defaultAssigneeId;
        // Sablondan kopyalanan istege bagli alanlar yeni sablondan gelir (kaldirilan alan gorevde kalmasin).
        const { assigneeId: _a, cancelReason: _c, asset: _as, equipmentId: _eq, blockIds: _b, ...rest } = t;
        out.push({
          item: {
            ...rest,
            ...snapshotOf(next, link),
            templateVersion: next.version,
            status: 'scheduled',
            ...(keepAssignee ? { assigneeId: t.assigneeId } : next.defaultAssigneeId ? { assigneeId: next.defaultAssigneeId } : {}),
            ...touch(t),
          },
          expectedVersion: t.version,
        });
      }
    }
    if (next) for (const d of desired) out.push({ item: newTask(next, d, ctx.userId, ts, link), expectedVersion: 0 });
    if (out.length > MAX_TASKS_PER_WRITE) throw new TicketError('unprocessable', 'Bu değişiklik çok fazla görevi etkiliyor; sıklığı daha az değiştirin');
    return out;
  }

  async function archiveTemplate(ctx: MaintenanceContext, templateId: string, body: unknown) {
    requireManager(ctx);
    const version = reqInt(asObject(body), 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await loadTemplate(ctx, templateId);
    if (current.status === 'archived') return { template: templateView(current), tasksChanged: 0 };
    if (current.version !== version) throw new TicketError('conflict', 'Şablon başka bir işlemle değişti; sayfayı yenileyin');
    const ts = stamp();
    const next: MaintenanceTemplate = { ...current, status: 'archived', updatedAt: ts, updatedBy: ctx.userId, version: version + 1 };
    const tasks = await reconcileTasks(ctx, current, undefined, ts);
    await write(ctx.apartmentId, {
      at: ts,
      template: { item: next, expectedVersion: version },
      tasks,
      audit: { apartmentId: ctx.apartmentId, action: 'maintenance.template_archive', target: { type: 'maintenance_template', id: templateId }, details: { name: current.name, tasksCancelled: tasks.length } },
    });
    return { template: templateView(next), tasksChanged: tasks.length };
  }

  // -------------------------------------------------------------------------
  // Gorev uretimi (zamanlayici)
  // -------------------------------------------------------------------------

  /** `maintenance_tasks` isi: her aktif sablonun penceresindeki eksik gorevleri olusturur (idempotent). */
  async function generate(apartmentId: string, day: IsoDate) {
    const templates = (await repo.listTemplates(apartmentId)).filter((t) => t.status === 'active');
    const ts = stamp();
    const links = new Map<string, string | null>();
    let created = 0;
    let existing = 0;
    for (const t of templates) {
      const link = await linkFor(t, links);
      for (const d of occurrences(t.schedule, day, addDays(day, t.leadDays + GENERATION_HORIZON_DAYS), MAX_TASKS_PER_WRITE)) {
        if (await repo.createTaskIfAbsent(newTask(t, d, 'system-scheduler', ts, link))) created++;
        else existing++;
      }
    }
    return { templates: templates.length, created, existing };
  }

  // -------------------------------------------------------------------------
  // Gorevler
  // -------------------------------------------------------------------------

  /**
   * Gorev gorunumu. `equipmentId` etkin baglantidir (`taskEquipmentId`: acik baglanti, yoksa v2
   * oncesi gorevde sablonun guncel baglantisi); `null` istemciye donmez. Bina gorevlisi masraf
   * ozetini gormez (talep gorunumuyle ayni kural; masraf uclari da yonetim + denetci).
   */
  function taskView(t: MaintenanceTask, ctx: MaintenanceContext, settings?: TicketSettings, template?: Pick<MaintenanceTemplate, 'equipmentId'>) {
    const { PK: _pk, SK: _sk, equipmentId: _eq, costSummary, ...rest } = t;
    const equipmentId = taskEquipmentId(t, template);
    const d = today();
    const open = OPEN_TASK_STATUSES.includes(t.status);
    return {
      ...rest,
      ...(costSummary && kindOf(ctx) !== 'staff' ? { costSummary } : {}),
      ...(equipmentId ? { equipmentId } : {}),
      overdue: open && t.dueDate < d,
      ...(settings ? { actions: taskActions(ctx, t, settings) } : {}),
    };
  }

  /** v2 oncesi (baglanti alani olmayan) gorev varsa etkin ekipman icin sablonlar okunur (tek sorgu). */
  async function templatesFor(apartmentId: string, tasks: readonly MaintenanceTask[]): Promise<Map<string, MaintenanceTemplate>> {
    if (!tasks.some((t) => t.equipmentId === undefined)) return new Map();
    return new Map((await repo.listTemplates(apartmentId)).map((t) => [t.templateId, t]));
  }

  function taskActions(ctx: MaintenanceContext, t: MaintenanceTask, settings: TicketSettings): string[] {
    const kind = kindOf(ctx);
    if (kind === 'observer') return [];
    const mine = t.assigneeId === ctx.userId;
    const out: string[] = [];
    const open = OPEN_TASK_STATUSES.includes(t.status);
    if (open && (kind === 'manager' || (kind === 'staff' && settings.staffSelfAssign && !t.assigneeId))) out.push('assign');
    if (t.status === 'scheduled' && (kind === 'manager' || mine)) out.push('start');
    if (open && (kind === 'manager' || mine)) out.push('complete');
    if (open && kind === 'manager') out.push('skip');
    if (t.status !== 'cancelled' && (kind === 'manager' || mine)) out.push('ticket');
    // v2: tahmini tutar notu (yapilacak veya yapilmis gorevde; iptal / atlanmis haric).
    if (t.status !== 'cancelled' && t.status !== 'skipped' && (kind === 'manager' || mine)) out.push('estimate');
    return out;
  }

  function canSee(ctx: MaintenanceContext, t: MaintenanceTask, settings: TicketSettings): boolean {
    const kind = kindOf(ctx);
    if (kind !== 'staff') return true;
    return t.assigneeId === ctx.userId || (settings.staffSelfAssign && !t.assigneeId && OPEN_TASK_STATUSES.includes(t.status));
  }

  async function loadTask(ctx: MaintenanceContext, taskId: string) {
    const key = parseTaskId(taskId);
    if (!key) throw new TicketError('not_found', 'Bakım görevi bulunamadı');
    const [task, settings] = await Promise.all([repo.getTask(ctx.apartmentId, key.dueDate, key.templateId), deps.tickets.settingsOf(ctx.apartmentId)]);
    if (!task || !canSee(ctx, task, settings)) throw new TicketError('not_found', 'Bakım görevi bulunamadı');
    // v2 oncesi gorevde etkin ekipman sablonun guncel baglantisidir.
    const template = task.equipmentId === undefined ? await repo.getTemplate(ctx.apartmentId, task.templateId) : undefined;
    const view = (t: MaintenanceTask) => taskView(t, ctx, settings, template);
    return { task, settings, template, view };
  }

  /**
   * Gorev listesi. Varsayilan aralik: bugun - 90 .. bugun + 60 gun. `status` virgullu ya da `open`;
   * `assignee`: me | none | kullanici; `overdue=true`; `templateId`.
   */
  async function listTasks(ctx: MaintenanceContext, q: Record<string, string | undefined> = {}) {
    kindOf(ctx);
    const d = today();
    const from = q.from ?? addDays(d, -TASK_LIST_LOOKBACK_DAYS);
    const to = q.to ?? addDays(d, 60);
    if (!isIsoDate(from) || !isIsoDate(to)) throw new ValidationError('from / to YYYY-MM-DD olmalı', 'from');
    if (from > to) throw new ValidationError('from, to tarihinden sonra olamaz', 'from');
    let statuses: readonly TaskStatus[] | undefined;
    if (q.status) {
      statuses = q.status === 'open' ? OPEN_TASK_STATUSES : q.status.split(',').map((s) => {
        if (!(TASK_STATUSES as readonly string[]).includes(s)) throw new ValidationError('status geçersiz', 'status');
        return s as TaskStatus;
      });
    }
    const assignee = q.assignee === 'me' ? ctx.userId : q.assignee;
    const settings = await deps.tickets.settingsOf(ctx.apartmentId);
    const all = await repo.listTasks(ctx.apartmentId, from, to);
    const templates = await templatesFor(ctx.apartmentId, all);
    const items = all
      .filter((t) => canSee(ctx, t, settings))
      .filter((t) => (statuses ? statuses.includes(t.status) : t.status !== 'cancelled'))
      .filter((t) => !assignee || (assignee === 'none' ? !t.assigneeId : t.assigneeId === assignee))
      .filter((t) => !q.templateId || t.templateId === q.templateId)
      // Gecmis ve gorunumle ayni kural (`taskEquipmentId`).
      .filter((t) => !q.equipmentId || taskEquipmentId(t, templates.get(t.templateId)) === q.equipmentId)
      .filter((t) => q.overdue !== 'true' || (OPEN_TASK_STATUSES.includes(t.status) && t.dueDate < d))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name, 'tr'));
    return { from, to, items: items.map((t) => taskView(t, ctx, settings, templates.get(t.templateId))) };
  }

  /** Ay gorunumu: aydaki gorevler + aydan once kalmis acik (geciken) gorevler (son 1 yil). */
  async function calendar(ctx: MaintenanceContext, q: { month?: string } = {}) {
    kindOf(ctx);
    const month = q.month ?? today().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ValidationError('month YYYY-MM olmalı', 'month');
    const first = `${month}-01` as IsoDate;
    const last = addDays(addMonthsClamped(first, 1), -1);
    const settings = await deps.tickets.settingsOf(ctx.apartmentId);
    const d = today();
    const [inMonth, before] = await Promise.all([repo.listTasks(ctx.apartmentId, first, last), repo.listTasks(ctx.apartmentId, addDays(d, -365), addDays(first, -1))]);
    const templates = await templatesFor(ctx.apartmentId, [...inMonth, ...before]);
    const view = (t: MaintenanceTask) => taskView(t, ctx, settings, templates.get(t.templateId));
    return {
      month,
      items: inMonth.filter((t) => t.status !== 'cancelled' && canSee(ctx, t, settings)).map(view),
      overdue: before.filter((t) => OPEN_TASK_STATUSES.includes(t.status) && t.dueDate < d && canSee(ctx, t, settings)).map(view),
    };
  }

  /**
   * Yalnizca sayilar (yonetim portfoyu), tek sorgu: geciken acik gorevler (Genel Bakis'in "geciken
   * bakim" sayisiyla ayni kural: `GET /tasks?status=open&overdue=true` varsayilan penceresi, son
   * `TASK_LIST_LOOKBACK_DAYS` gun, son gunu bugunden once) ve onumuzdeki 7 gunde (bugun dahil) son gunu
   * gelen acik gorevler. Takvimin "geciken" listesi 1 yil geriye bakar; o ekran ayridir.
   */
  async function stats(ctx: MaintenanceContext) {
    kindOf(ctx);
    const d = today();
    const weekEnd = addDays(d, 6);
    const [settings, tasks] = await Promise.all([
      deps.tickets.settingsOf(ctx.apartmentId),
      repo.listTasks(ctx.apartmentId, addDays(d, -TASK_LIST_LOOKBACK_DAYS), weekEnd),
    ]);
    const open = tasks.filter((t) => OPEN_TASK_STATUSES.includes(t.status) && canSee(ctx, t, settings));
    return {
      overdueCount: open.filter((t) => t.dueDate < d).length,
      dueThisWeekCount: open.filter((t) => t.dueDate >= d && t.dueDate <= weekEnd).length,
    };
  }

  async function getTask(ctx: MaintenanceContext, taskId: string) {
    kindOf(ctx);
    const { task, view } = await loadTask(ctx, taskId);
    return { task: view(task) };
  }

  async function saveTask(ctx: MaintenanceContext, task: MaintenanceTask, next: MaintenanceTask, audit?: string, details: Record<string, unknown> = {}) {
    await write(ctx.apartmentId, {
      at: next.updatedAt,
      tasks: [{ item: next, expectedVersion: task.version }],
      ...(audit ? { audit: { apartmentId: ctx.apartmentId, action: audit, target: { type: 'maintenance_task', id: task.taskId }, details: { name: task.name, dueDate: task.dueDate, ...details } } } : {}),
    });
  }

  function guardVersion(task: MaintenanceTask, o: Obj) {
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    if (task.version !== version) throw new TicketError('conflict', 'Görev başka bir işlemle değişti; sayfayı yenileyin');
  }

  const touch = (ctx: MaintenanceContext, t: MaintenanceTask) => ({ updatedAt: stamp(), updatedBy: ctx.userId, version: t.version + 1 });

  async function assignTask(ctx: MaintenanceContext, taskId: string, body: unknown) {
    const o = asObject(body);
    const { task, settings, view } = await loadTask(ctx, taskId);
    if (!taskActions(ctx, task, settings).includes('assign')) throw new TicketError(OPEN_TASK_STATUSES.includes(task.status) ? 'forbidden' : 'invalid_state', 'Bu görevi atayamazsınız');
    guardVersion(task, o);
    const assigneeId = o.assigneeId === null || o.assigneeId === '' ? null : assertId(o.assigneeId, 'assigneeId');
    if (kindOf(ctx) === 'staff' && assigneeId !== ctx.userId) throw new TicketError('forbidden', 'Yalnızca kendinize üstlenebilirsiniz');
    if (assigneeId && !(await activeStaff(ctx.apartmentId)).includes(assigneeId)) throw new TicketError('unprocessable', 'Seçilen kişi bu apartmanın aktif bina görevlisi değil');
    const { assigneeId: _old, ...rest } = task;
    const next: MaintenanceTask = { ...rest, ...(assigneeId ? { assigneeId } : {}), ...touch(ctx, task) };
    await saveTask(ctx, task, next, 'maintenance.task_assign', { from: task.assigneeId ?? null, to: assigneeId });
    return { task: view(next) };
  }

  async function startTask(ctx: MaintenanceContext, taskId: string, body: unknown) {
    const o = asObject(body);
    const { task, settings, view } = await loadTask(ctx, taskId);
    if (!taskActions(ctx, task, settings).includes('start')) throw new TicketError(task.status === 'scheduled' ? 'forbidden' : 'invalid_state', 'Bu görevi başlatamazsınız');
    guardVersion(task, o);
    const next: MaintenanceTask = { ...task, status: 'in_progress', startedAt: stamp(), startedBy: ctx.userId, ...touch(ctx, task) };
    await saveTask(ctx, task, next, 'maintenance.task_start');
    return { task: view(next) };
  }

  /**
   * Kontrol listesiyle tamamlama. Zorunlu maddelerin hepsine sonuc verilmeli; basarisiz madde notu
   * zorunlu. Basarisiz madde varsa yanit `suggestTicket: true` doner (arayuz "Ariza ac" onerir).
   */
  async function completeTask(ctx: MaintenanceContext, taskId: string, body: unknown) {
    const o = asObject(body);
    const { task, settings, view } = await loadTask(ctx, taskId);
    if (!taskActions(ctx, task, settings).includes('complete')) throw new TicketError(OPEN_TASK_STATUSES.includes(task.status) ? 'forbidden' : 'invalid_state', 'Bu görevi tamamlayamazsınız');
    guardVersion(task, o);
    const raw = o.checklistResults ?? [];
    if (!Array.isArray(raw)) throw new ValidationError('checklistResults bir dizi olmalı', 'checklistResults');
    const known = new Map(task.checklist.map((c) => [c.id, c]));
    const results: ChecklistResult[] = [];
    for (const [i, r] of raw.entries()) {
      const x = asObject(r, `checklistResults[${i}]`);
      const id = reqString(x, 'id', 10);
      if (!known.has(id)) throw new ValidationError(`checklistResults[${i}].id bilinmeyen madde`, 'checklistResults');
      if (results.some((y) => y.id === id)) throw new ValidationError(`checklistResults[${i}] tekrarlanan madde`, 'checklistResults');
      if (typeof x.ok !== 'boolean') throw new ValidationError(`checklistResults[${i}].ok true veya false olmalı`, 'checklistResults');
      const note = optString(x, 'note', 500)?.trim();
      if (!x.ok && (!note || note.length < 3)) throw new ValidationError(`"${known.get(id)?.text}" maddesi için açıklama gerekli`, 'checklistResults');
      results.push({ id, ok: x.ok, ...(note ? { note } : {}) });
    }
    const missing = task.checklist.filter((c) => c.required && !results.some((r) => r.id === c.id));
    if (missing.length) throw new ValidationError(`Zorunlu madde yanıtlanmadı: ${missing.map((m) => m.text).join(', ')}`, 'checklistResults');
    const note = optString(o, 'note', 2000)?.trim();
    const uploadIds = parseUploadIds(o.photos);
    const photoKeys = await photos.attachTo(ctx.apartmentId, ctx.userId, `apartments/${ctx.apartmentId}/maintenance/${task.taskId}/`, uploadIds);
    const ts = stamp();
    const next: MaintenanceTask = {
      ...task,
      status: 'done',
      ...(task.startedAt ? {} : { startedAt: ts, startedBy: ctx.userId }),
      completedAt: ts,
      completedBy: ctx.userId,
      checklistResults: results,
      ...(note ? { note } : {}),
      ...(photoKeys.length ? { photoKeys: [...(task.photoKeys ?? []), ...photoKeys] } : {}),
      ...touch(ctx, task),
    };
    const failed = results.filter((r) => !r.ok).length;
    await saveTask(ctx, task, next, 'maintenance.task_complete', { failedItems: failed });
    return { task: view(next), failedItems: failed, suggestTicket: failed > 0 };
  }

  async function skipTask(ctx: MaintenanceContext, taskId: string, body: unknown) {
    const o = asObject(body);
    const { task, settings, view } = await loadTask(ctx, taskId);
    if (!taskActions(ctx, task, settings).includes('skip')) throw new TicketError(OPEN_TASK_STATUSES.includes(task.status) ? 'forbidden' : 'invalid_state', 'Bu görevi atlayamazsınız');
    guardVersion(task, o);
    const reason = reqString(o, 'reason', 500, 3).trim();
    const next: MaintenanceTask = { ...task, status: 'skipped', skipReason: reason, ...touch(ctx, task) };
    await saveTask(ctx, task, next, 'maintenance.task_skip', { reason });
    return { task: view(next) };
  }

  /**
   * Gorevden ariza ac: ortak alan talebi (yer = ekipman ya da gorev adi, tek blok varsa blok),
   * kategori gorevin kategorisi, kaynak `maintenance`. Talep idempotency anahtariyla korunur;
   * gorevin `ticketIds` listesi ayni cagrinin tekrarinda iki kez eklenmez.
   */
  async function openTicket(ctx: MaintenanceContext, taskId: string, body: unknown) {
    const o = asObject(body);
    const { task, settings, template } = await loadTask(ctx, taskId);
    if (!taskActions(ctx, task, settings).includes('ticket')) throw new TicketError('forbidden', 'Bu görevden arıza açamazsınız');
    const failedText = (task.checklistResults ?? [])
      .filter((r) => !r.ok)
      .map((r) => `- ${task.checklist.find((c) => c.id === r.id)?.text ?? r.id}${r.note ? `: ${r.note}` : ''}`)
      .join('\n');
    // v2: gorevin etkin ekipmani (gecmisle ayni kural) talebe de baglanir; hizmetten cikmis
    // ekipmana yeni talep baglanmaz. Yer metni yoksa ekipman adi kullanilir.
    const linked = taskEquipmentId(task, template);
    const equipment = linked ? await deps.equipment.get(ctx.apartmentId, linked) : undefined;
    const link = equipment && equipment.status !== 'retired' ? equipment.equipmentId : undefined;
    const area = task.asset ?? equipment?.name ?? task.name;
    const result = await deps.tickets.create(
      ctx,
      {
        idempotencyKey: o.idempotencyKey,
        title: o.title ?? `${task.name} - bulgu`,
        description: o.description ?? (failedText ? `Bakım kontrolünde sorun bulundu (${task.dueDate}):\n${failedText}` : `${task.name} (${task.dueDate}) sırasında tespit edildi.`),
        category: task.category,
        ...(o.priority !== undefined ? { priority: reqEnum(o, 'priority', TICKET_PRIORITIES) } : {}),
        location: { kind: 'common', area: area.slice(0, 80), ...(task.blockIds?.length === 1 ? { blockId: task.blockIds[0] } : {}) },
        ...(o.photos !== undefined ? { photos: o.photos } : {}),
      },
      { maintenanceTaskId: task.taskId, ...(link ? { equipmentId: link } : {}) },
    );
    const ticketId = result.ticket.ticketId;
    for (let attempt = 1; ; attempt++) {
      const key = parseTaskId(taskId);
      const fresh = key ? await repo.getTask(ctx.apartmentId, key.dueDate, key.templateId) : undefined;
      if (!fresh || fresh.ticketIds.includes(ticketId)) break;
      try {
        await repo.write(ctx.apartmentId, { at: stamp(), tasks: [{ item: { ...fresh, ticketIds: [...fresh.ticketIds, ticketId], ...touch(ctx, fresh) }, expectedVersion: fresh.version }] });
        break;
      } catch (err) {
        if (!(err instanceof MaintenanceConflictError) || attempt >= 3) throw err instanceof MaintenanceConflictError ? new TicketError('conflict', err.message) : err;
      }
    }
    return result;
  }

  /**
   * v2: gorevlinin tahmini tutar notu `{ version, amount: kurus | null, note? }` (yonetim veya
   * gorevin gorevlisi). Bilgi amaclidir; Finans'a yazilmaz. Denetim kaydiyla ayni yazimda.
   */
  async function estimateTask(ctx: MaintenanceContext, taskId: string, body: unknown) {
    const o = asObject(body);
    const { task, settings, view } = await loadTask(ctx, taskId);
    if (!taskActions(ctx, task, settings).includes('estimate')) {
      const closed = task.status === 'cancelled' || task.status === 'skipped';
      throw new TicketError(closed ? 'invalid_state' : 'forbidden', closed ? 'İptal edilmiş veya atlanmış göreve tahmini tutar girilemez' : 'Tahmini tutarı yalnızca yönetim ve görevin görevlisi girebilir');
    }
    guardVersion(task, o);
    const clear = o.amount === null;
    const amount = clear ? undefined : reqInt(o, 'amount', 0, MAX_AMOUNT);
    const note = clear ? undefined : optString(o, 'note', 300)?.trim() || undefined;
    if (clear && !task.estimate) return { task: view(task) };
    if (!clear && task.estimate?.amount === amount && task.estimate?.note === note) return { task: view(task) };
    const { estimate: previous, ...rest } = task;
    const ts = stamp();
    const next: MaintenanceTask = {
      ...rest,
      ...(amount !== undefined ? { estimate: { amount, ...(note ? { note } : {}), at: ts, by: ctx.userId, byRole: ctx.role } } : {}),
      ...touch(ctx, task),
    };
    await saveTask(ctx, task, next, 'maintenance.task_estimate', { amount: amount ?? null, previous: previous?.amount ?? null });
    return { task: view(next) };
  }

  async function photoUploadUrl(ctx: MaintenanceContext, body: unknown) {
    if (kindOf(ctx) === 'observer') throw new TicketError('forbidden', 'Denetçi fotoğraf yükleyemez');
    return photos.presignUpload(ctx.apartmentId, ctx.userId, body);
  }

  async function photo(ctx: MaintenanceContext, taskId: string, photoId: string) {
    kindOf(ctx);
    const { task } = await loadTask(ctx, taskId);
    const key = (task.photoKeys ?? []).find((k) => photoIdOf(k) === photoId);
    if (!key) throw new TicketError('not_found', 'Fotoğraf bulunamadı');
    return photos.presignDownload(key, `bakim-${task.dueDate}`);
  }

  // -------------------------------------------------------------------------
  // Gunluk ozet (zamanlayici)
  // -------------------------------------------------------------------------

  /** Acik gorevlerden yaklasan (bugun .. +2 gun) ve geciken (son 1 yil) kalemler. */
  async function digestItems(apartmentId: string, day: IsoDate) {
    const tasks = await repo.listTasks(apartmentId, addDays(day, -365), addDays(day, DUE_SOON_DAYS - 1));
    const open = tasks.filter((t) => OPEN_TASK_STATUSES.includes(t.status));
    const item = (t: MaintenanceTask) => ({ taskId: t.taskId, name: t.name, dueDate: t.dueDate, ...(t.assigneeId ? { assigneeId: t.assigneeId } : {}) });
    return {
      dueSoon: open.filter((t) => t.dueDate >= day).map(item),
      overdue: open.filter((t) => t.dueDate < day).map(item),
    };
  }

  return {
    presets,
    listTemplates,
    getTemplate,
    createTemplate,
    updateTemplate,
    archiveTemplate,
    generate,
    listTasks,
    calendar,
    stats,
    getTask,
    assignTask,
    startTask,
    completeTask,
    skipTask,
    openTicket,
    estimateTask,
    photoUploadUrl,
    photo,
    digestItems,
  };
}

export type MaintenanceService = ReturnType<typeof createMaintenanceService>;
