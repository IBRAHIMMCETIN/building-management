import { randomUUID } from 'node:crypto';
import { getTenantItem, queryTenantAll } from '../../config/dynamodb.js';
import type { IsoDateTime, LiableParty } from '../core/types.js';
import { ValidationError, asObject, assertId, reqEnum, reqString } from '../core/validation.js';
import { type FinanceRepository, type ReplaceRecord, financeRepository } from '../finance/repository.js';
import { FinanceError, type FinanceService, REPAIR_RECHARGE_INCOME, type WorkLinkWrite } from '../finance/service.js';
import type { Transaction } from '../finance/types.js';
import { type MaintenanceTask, type MaintenanceTemplate, maintenanceKeys, parseTaskId } from '../maintenance/types.js';
import { type Ticket, type TicketEvent, ticketKeys } from '../tickets/types.js';
import {
  type CostItem,
  type CostMode,
  type CostRecharge,
  type CostSummary,
  type ExpenseLinkRecord,
  EXPLINK_PREFIX,
  type WorkKind,
  expenseAccountFor,
  workCostKeys,
} from './types.js';

export type WorkCostContext = { apartmentId: string; userId: string; role: string };

/** Talep / gorev / sablon / kilit okumalari (tek tablo). */
export type WorkCostSource = {
  getTicket(apartmentId: string, ticketId: string): Promise<Ticket | undefined>;
  getTask(apartmentId: string, taskId: string): Promise<MaintenanceTask | undefined>;
  getTemplate(apartmentId: string, templateId: string): Promise<MaintenanceTemplate | undefined>;
  getLink(apartmentId: string, expenseId: string): Promise<ExpenseLinkRecord | undefined>;
  listLinks(apartmentId: string): Promise<ExpenseLinkRecord[]>;
};

export const dynamoWorkCostSource: WorkCostSource = {
  getTicket: (apt, id) => getTenantItem<Ticket>(ticketKeys.ticket(apt, id)),
  async getTask(apt, taskId) {
    const p = parseTaskId(taskId);
    return p ? getTenantItem<MaintenanceTask>(maintenanceKeys.task(apt, p.dueDate, p.templateId)) : undefined;
  },
  getTemplate: (apt, id) => getTenantItem<MaintenanceTemplate>(maintenanceKeys.template(apt, id)),
  getLink: (apt, id) => getTenantItem<ExpenseLinkRecord>(workCostKeys.link(apt, id)),
  listLinks: async (apt) => (await queryTenantAll<ExpenseLinkRecord>(apt, EXPLINK_PREFIX)).filter((l) => l.entityType === 'EXPENSE_LINK'),
};

export type WorkCostServiceDeps = {
  finance: Pick<FinanceService, 'recordExpense' | 'chargeUnit' | 'postWorkDocuments' | 'expenseInfo' | 'isReversed'>;
  source?: WorkCostSource;
  /** Baglanabilir gider listesi (Finans gider kayitlari). */
  expenses?: Pick<FinanceRepository, 'listExpenses'>;
  now?: () => Date;
  newId?: () => string;
};

type Target = {
  kind: WorkKind;
  id: string;
  label: string;
  status: string;
  record: Ticket | MaintenanceTask;
  summary: CostSummary;
  /** Iptal edilmis is: masraf baglanamaz. */
  closed: boolean;
  /** Daire ici talep. */
  unitId?: string;
  number?: string;
  title?: string;
  defaults: { expenseAccountId: string; creditAccountId?: string };
};

const EMPTY: CostSummary = { total: 0, expenseIds: [] };
const trDate = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const sum = (xs: readonly { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);

/**
 * Faz 3 (O1-4): ariza talebi ve bakim gorevinin masraflari.
 *
 *  - `expense` modu: Finans `recordExpense` ile yeni gider; gider + talep/gorev ozeti + EXPLINK
 *    kilidi + (talepte) `cost_linked` olayi + denetim kaydi TEK atomik yazim.
 *  - `link` modu: Finans'ta var olan gider baglanir (deftere yazim yok); kilit `attribute_not_exists`
 *    ya da surumle: bir masraf yalnizca bir ise bagli olabilir.
 *  - Bag kaldirma yalnizca `link` modunda ve gerekceyle; bu isten kaydedilen gider Finans'ta ters
 *    kayitla duzeltilir (okuma aninda `reversed`).
 *  - Daireye yansitma (karar 4): yalnizca yonetim, daire ici talep, `confirm: true` ve malik /
 *    oturan secimiyle; "Onarim Yansitma Gelirleri" hesabina tahakkuk + talep ozeti atomik.
 */
export function createWorkCostService(deps: WorkCostServiceDeps) {
  const source = deps.source ?? dynamoWorkCostSource;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());
  const { finance } = deps;

  async function loadTarget(apartmentId: string, kind: WorkKind, id: string): Promise<Target> {
    assertId(id, kind === 'ticket' ? 'ticketId' : 'taskId');
    if (kind === 'ticket') {
      const t = await source.getTicket(apartmentId, id);
      if (!t) throw new FinanceError('not_found', 'Talep bulunamadi');
      return {
        kind,
        id,
        label: `${t.number} ${t.title}`.slice(0, 200),
        status: t.status,
        record: t,
        summary: t.costSummary ?? EMPTY,
        closed: t.status === 'cancelled',
        ...(t.location.kind === 'unit' ? { unitId: t.location.unitId } : {}),
        number: t.number,
        title: t.title,
        defaults: { expenseAccountId: expenseAccountFor(t.category) },
      };
    }
    const task = await source.getTask(apartmentId, id);
    if (!task) throw new FinanceError('not_found', 'Bakim gorevi bulunamadi');
    const tpl = await source.getTemplate(apartmentId, task.templateId);
    return {
      kind,
      id,
      label: `${task.name} (${trDate(task.dueDate)})`.slice(0, 200),
      status: task.status,
      record: task,
      summary: task.costSummary ?? EMPTY,
      closed: task.status === 'cancelled',
      defaults: {
        expenseAccountId: tpl?.expenseAccountId ?? expenseAccountFor(task.category),
        ...(tpl?.supplierAccountId ? { creditAccountId: tpl.supplierAccountId } : {}),
      },
    };
  }

  function requireOpen(t: Target) {
    if (t.closed) throw new FinanceError('unprocessable', t.kind === 'ticket' ? 'Iptal edilmis talebe masraf baglanamaz' : 'Iptal edilmis bakim gorevine masraf baglanamaz');
  }

  function replaceTarget(t: Target, summary: CostSummary, ctx: WorkCostContext, at: IsoDateTime): ReplaceRecord {
    const r = t.record;
    const item: Ticket | MaintenanceTask = { ...r, costSummary: summary, version: r.version + 1, updatedAt: at, updatedBy: ctx.userId };
    return {
      item,
      expectedVersion: r.version,
      label: t.kind,
    };
  }

  function ticketEvent(
    t: Target,
    ctx: WorkCostContext,
    at: IsoDateTime,
    kind: 'cost_linked' | 'cost_unlinked' | 'cost_charged',
    extra: Pick<TicketEvent, 'amount' | 'expenseId' | 'transactionId' | 'body'>,
  ): TicketEvent[] {
    if (t.kind !== 'ticket') return [];
    const eventId = newId();
    return [
      {
        ...ticketKeys.event(ctx.apartmentId, t.id, at, eventId),
        entityType: 'TICKET_EVENT',
        apartmentId: ctx.apartmentId,
        ticketId: t.id,
        eventId,
        kind,
        // Masraf bilgisi sakine gosterilmez.
        visibility: 'internal',
        at,
        by: ctx.userId,
        byRole: ctx.role,
        ...extra,
      },
    ];
  }

  function linkRecord(
    ctx: WorkCostContext,
    t: Target,
    item: CostItem,
    prev?: ExpenseLinkRecord,
  ): { replaceRecords: ReplaceRecord[]; newDocs: ExpenseLinkRecord[] } {
    const rec: ExpenseLinkRecord = {
      ...workCostKeys.link(ctx.apartmentId, item.expenseId),
      entityType: 'EXPENSE_LINK',
      apartmentId: ctx.apartmentId,
      expenseId: item.expenseId,
      transactionId: item.transactionId,
      amount: item.amount,
      target: { type: t.kind, id: t.id, label: t.label },
      mode: item.mode,
      status: 'active',
      linkedAt: item.linkedAt,
      linkedBy: item.linkedBy,
      version: (prev?.version ?? 0) + 1,
    };
    return prev
      ? { replaceRecords: [{ item: rec, expectedVersion: prev.version, label: 'explink' }], newDocs: [] }
      : { replaceRecords: [], newDocs: [rec] };
  }

  const withItem = (s: CostSummary, item: CostItem): CostSummary => ({
    ...s,
    total: s.total + item.amount,
    expenseIds: [...s.expenseIds, item.expenseId],
    items: [...(s.items ?? []), item],
  });

  // -------------------------------------------------------------------------
  // Okuma
  // -------------------------------------------------------------------------

  async function costs(ctx: WorkCostContext, kind: WorkKind, id: string) {
    const t = await loadTarget(ctx.apartmentId, kind, id);
    const items = await Promise.all(
      (t.summary.items ?? []).map(async (i) => {
        const info = await finance.expenseInfo(ctx, i.expenseId).catch(() => undefined);
        const e = info?.expense;
        return {
          ...i,
          reversed: info?.reversed ?? false,
          ...(e
            ? {
                expenseAccountId: e.expenseAccountId,
                creditAccountId: e.creditAccountId,
                ...(e.supplier ? { supplier: e.supplier } : {}),
                ...(e.invoiceNumber ? { invoiceNumber: e.invoiceNumber } : {}),
                hasInvoice: !!e.invoice,
              }
            : {}),
        };
      }),
    );
    const recharges = await Promise.all((t.summary.recharges ?? []).map(async (r) => ({ ...r, reversed: await finance.isReversed(ctx, r.transactionId) })));
    const total = sum(items.filter((i) => !i.reversed));
    const rechargedTotal = sum(recharges.filter((r) => !r.reversed));
    return {
      target: { kind, id, label: t.label, status: t.status, ...(t.unitId ? { unitId: t.unitId } : {}) },
      items,
      recharges,
      total,
      rechargedTotal,
      /** Daireye yansitilabilecek en fazla tutar (yalnizca daire ici talep). */
      rechargeable: t.kind === 'ticket' && t.unitId ? Math.max(0, total - rechargedTotal) : 0,
      suggestion: t.defaults,
    };
  }

  // -------------------------------------------------------------------------
  // Masraf ekleme / baglama
  // -------------------------------------------------------------------------

  async function add(ctx: WorkCostContext, kind: WorkKind, id: string, body: unknown) {
    const o = asObject(body);
    const mode = reqEnum(o, 'mode', ['expense', 'link'] as const) as CostMode;
    const idempotencyKey = assertId(o.idempotencyKey, 'idempotencyKey');
    const t = await loadTarget(ctx.apartmentId, kind, id);
    requireOpen(t);
    const work = { type: kind, id, label: t.label };

    if (mode === 'expense') {
      const { mode: _m, ...rest } = o;
      const r = await finance.recordExpense(
        ctx,
        {
          ...rest,
          expenseAccountId: o.expenseAccountId ?? t.defaults.expenseAccountId,
          ...(o.creditAccountId !== undefined || t.defaults.creditAccountId ? { creditAccountId: o.creditAccountId ?? t.defaults.creditAccountId } : {}),
          description: o.description ?? t.label,
        },
        {
          fp: { work: `${kind}:${id}` },
          expenseLink: work,
          async build({ transaction, expense }): Promise<WorkLinkWrite> {
            if (!expense) throw new Error('gider kaydi yok');
            const cur = await loadTarget(ctx.apartmentId, kind, id);
            requireOpen(cur);
            const item: CostItem = {
              expenseId: expense.expenseId,
              transactionId: transaction.transactionId,
              amount: expense.amount,
              mode: 'expense',
              date: expense.date,
              description: expense.description,
              linkedAt: transaction.createdAt,
              linkedBy: ctx.userId,
            };
            const lock = linkRecord(ctx, cur, item);
            return {
              replaceRecords: [replaceTarget(cur, withItem(cur.summary, item), ctx, transaction.createdAt)],
              newDocs: [...lock.newDocs, ...ticketEvent(cur, ctx, transaction.createdAt, 'cost_linked', { amount: item.amount, expenseId: item.expenseId, transactionId: item.transactionId, body: item.description })],
              auditDetails: { work },
            };
          },
        },
      );
      return { ...(await costs(ctx, kind, id)), expenseId: r.expense.expenseId, transactionId: r.transaction.transactionId, replayed: r.replayed };
    }

    const expenseId = assertId(o.expenseId, 'expenseId');
    const info = await finance.expenseInfo(ctx, expenseId);
    if (info.reversed) throw new FinanceError('unprocessable', 'Ters kayitla iptal edilmis gider baglanamaz');
    const r = await finance.postWorkDocuments(ctx, {
      idempotencyKey,
      fp: { op: 'cost_link', work: `${kind}:${id}`, expenseId },
      action: `${kind}.cost_link`,
      target: { type: kind, id },
      async build() {
        const cur = await loadTarget(ctx.apartmentId, kind, id);
        requireOpen(cur);
        const prev = await source.getLink(ctx.apartmentId, expenseId);
        if (prev?.status === 'active') {
          throw new FinanceError(
            'conflict',
            prev.target.type === kind && prev.target.id === id ? 'Bu gider zaten bu ise bagli' : `Bu gider baska bir ise bagli: ${prev.target.label}`,
          );
        }
        const at = now().toISOString();
        const e = info.expense;
        const item: CostItem = { expenseId, transactionId: e.transactionId, amount: e.amount, mode: 'link', date: e.date, description: e.description, linkedAt: at, linkedBy: ctx.userId };
        const lock = linkRecord(ctx, cur, item, prev);
        return {
          replaceRecords: [replaceTarget(cur, withItem(cur.summary, item), ctx, at), ...lock.replaceRecords],
          newDocs: [...lock.newDocs, ...ticketEvent(cur, ctx, at, 'cost_linked', { amount: item.amount, expenseId, transactionId: e.transactionId, body: e.description })],
          auditDetails: { work, expenseId, transactionId: e.transactionId, amount: e.amount },
        };
      },
    });
    return { ...(await costs(ctx, kind, id)), expenseId, transactionId: info.expense.transactionId, replayed: r.replayed };
  }

  /** Yalnizca `link` modundaki bag kaldirilir (gider Finans'ta kalir). */
  async function unlink(ctx: WorkCostContext, kind: WorkKind, id: string, expenseId: string, body: unknown) {
    assertId(expenseId, 'expenseId');
    const reason = reqString(asObject(body), 'reason', 300);
    const t = await loadTarget(ctx.apartmentId, kind, id);
    const existing = t.summary.items?.find((i) => i.expenseId === expenseId);
    if (!existing) throw new FinanceError('not_found', 'Bu iste boyle bir masraf yok');
    if (existing.mode !== 'link') {
      throw new FinanceError('unprocessable', 'Bu isten kaydedilen gider bagdan cikarilamaz; duzeltme Finans\'ta ters kayitla yapilir');
    }
    const lock0 = await source.getLink(ctx.apartmentId, expenseId);
    const r = await finance.postWorkDocuments(ctx, {
      // Deterministik: ayni bagin kaldirilmasi tekrar edilirse replay.
      idempotencyKey: `XU_${expenseId}_${lock0?.version ?? 0}`,
      fp: { op: 'cost_unlink', work: `${kind}:${id}`, expenseId, reason },
      action: `${kind}.cost_unlink`,
      target: { type: kind, id },
      reason,
      async build() {
        const cur = await loadTarget(ctx.apartmentId, kind, id);
        const item = cur.summary.items?.find((i) => i.expenseId === expenseId);
        const lock = await source.getLink(ctx.apartmentId, expenseId);
        if (!item || !lock || lock.status !== 'active' || lock.target.id !== id || lock.target.type !== kind) {
          throw new FinanceError('conflict', 'Bag degismis; sayfayi yenileyin');
        }
        const at = now().toISOString();
        const summary: CostSummary = {
          ...cur.summary,
          total: cur.summary.total - item.amount,
          expenseIds: cur.summary.expenseIds.filter((x) => x !== expenseId),
          items: (cur.summary.items ?? []).filter((x) => x.expenseId !== expenseId),
        };
        const next: ExpenseLinkRecord = { ...lock, status: 'unlinked', unlinkedAt: at, unlinkedBy: ctx.userId, unlinkReason: reason, version: lock.version + 1 };
        return {
          replaceRecords: [replaceTarget(cur, summary, ctx, at), { item: next, expectedVersion: lock.version, label: 'explink' }],
          newDocs: ticketEvent(cur, ctx, at, 'cost_unlinked', { amount: item.amount, expenseId, transactionId: item.transactionId, body: reason }),
          auditDetails: { work: { type: kind, id, label: cur.label }, expenseId, amount: item.amount },
        };
      },
    });
    return { ...(await costs(ctx, kind, id)), replayed: r.replayed };
  }

  // -------------------------------------------------------------------------
  // Daireye yansitma (karar 4)
  // -------------------------------------------------------------------------

  async function charge(ctx: WorkCostContext, ticketId: string, body: unknown) {
    const o = asObject(body);
    if (o.confirm !== true) throw new ValidationError('Daireye yansitma icin acik onay gerekli (confirm: true)', 'confirm');
    const requestedParty = reqEnum(o, 'liableParty', ['owner', 'occupant'] as const) as LiableParty;
    const t = await loadTarget(ctx.apartmentId, 'ticket', ticketId);
    if (!t.unitId) throw new FinanceError('unprocessable', 'Yalnizca daire ici talebin masrafi daireye yansitilabilir');
    const amount = o.amount;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) throw new ValidationError('amount pozitif tam sayi (kurus) olmali', 'amount');
    const view = await costs(ctx, 'ticket', ticketId);
    if (amount > view.rechargeable) {
      throw new FinanceError('unprocessable', `Yansitilabilecek tutar en fazla ${view.rechargeable} kurus (bagli masraflar - onceki yansitmalar)`);
    }
    const unitId = t.unitId;
    const description = typeof o.description === 'string' && o.description.trim() ? o.description : `Onarım yansıtma: ${t.label}`.slice(0, 200);
    const r = await finance.chargeUnit(
      ctx,
      {
        idempotencyKey: o.idempotencyKey,
        unitId,
        liableParty: requestedParty,
        amount,
        ...(o.date !== undefined ? { date: o.date } : {}),
        dueDate: o.dueDate,
        description,
        incomeAccountId: REPAIR_RECHARGE_INCOME,
      },
      {
        fp: { work: `ticket:${ticketId}` },
        reference: `TICKET:${t.number}`,
        async build({ transaction }: { transaction: Transaction }): Promise<WorkLinkWrite> {
          const cur = await loadTarget(ctx.apartmentId, 'ticket', ticketId);
          // Es zamanli yansitmalara karsi yazilmis ozetle (iptaller haric degil) ust sinir.
          const already = sum(cur.summary.recharges ?? []);
          if (already + amount > cur.summary.total) throw new FinanceError('conflict', 'Masraf ozeti degisti; tutari yeniden kontrol edin');
          const charged = transaction.lines.find((l) => l.side === 'debit' && l.liableParty)?.liableParty ?? requestedParty;
          const recharge: CostRecharge = {
            transactionId: transaction.transactionId,
            amount,
            unitId,
            liableParty: charged,
            requestedParty,
            dueDate: transaction.dueDate ?? (transaction.date as CostRecharge['dueDate']),
            description: transaction.description,
            at: transaction.createdAt,
            by: ctx.userId,
          };
          const summary: CostSummary = { ...cur.summary, recharges: [...(cur.summary.recharges ?? []), recharge] };
          return {
            replaceRecords: [replaceTarget(cur, summary, ctx, transaction.createdAt)],
            newDocs: ticketEvent(cur, ctx, transaction.createdAt, 'cost_charged', { amount, transactionId: transaction.transactionId, body: charged === 'owner' ? 'Kat malikine yansıtıldı' : 'Oturana yansıtıldı' }),
            auditDetails: { work: { type: 'ticket', id: ticketId, label: cur.label }, recharge: { unitId, liableParty: charged, requestedParty } },
          };
        },
      },
    );
    return {
      ...(await costs(ctx, 'ticket', ticketId)),
      transactionId: r.transaction.transactionId,
      liableParty: r.liableParty,
      vacant: r.vacant,
      replayed: r.replayed,
    };
  }

  /**
   * Baglanabilecek giderler (en yeni 200): baska ise bagli olanlar isaretlenir. Iptal durumu
   * baglama aninda kontrol edilir (liste icin tek tek okunmaz).
   */
  async function expenseOptions(ctx: WorkCostContext, q: { from?: string } = {}) {
    const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : undefined;
    const repo = deps.expenses ?? financeRepository;
    const [expenses, links] = await Promise.all([repo.listExpenses ? repo.listExpenses(ctx.apartmentId) : Promise.resolve([]), source.listLinks(ctx.apartmentId)]);
    const linked = new Map(links.filter((l) => l.status === 'active').map((l) => [l.expenseId, l.target]));
    return {
      items: expenses
        .filter((e) => !from || e.date >= from)
        .sort((a, b) => b.date.localeCompare(a.date) || b.expenseId.localeCompare(a.expenseId))
        .slice(0, 200)
        .map((e) => ({
          expenseId: e.expenseId,
          date: e.date,
          description: e.description,
          amount: e.amount,
          expenseAccountId: e.expenseAccountId,
          ...(e.supplier ? { supplier: e.supplier } : {}),
          ...(e.invoiceNumber ? { invoiceNumber: e.invoiceNumber } : {}),
          ...(linked.has(e.expenseId) ? { linkedTo: linked.get(e.expenseId) } : {}),
        })),
    };
  }

  return { costs, add, unlink, charge, expenseOptions };
}

export type WorkCostService = ReturnType<typeof createWorkCostService>;
