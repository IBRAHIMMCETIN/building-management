import type { Role } from '../../auth/claims.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import { type IsoDate, type Kurus, type LiableParty, type Unit, toKurus, tenthsM2ToM2 } from '../core/types.js';
import { ValidationError, assertId, isIsoDate } from '../core/validation.js';
import { type FeeCharge, type FeeCredit, unpostedLateFee } from '../finance/lateFee.js';
import { DEFAULT_LATE_FEE_BASIS_POINTS } from '../finance/service.js';
import type { LedgerEntry, Payment, Transaction, TransactionKind } from '../finance/types.js';
import { type PortalRepository, portalRepository } from './repository.js';
import { type UnitMembership, type UnitRelation, visibleParties } from './types.js';

/**
 * Sakin portali (salt okunur).
 *
 * Erisim kurallari (savunma derinligi: rota katmani da ayni kontrolleri yapar):
 *  1. Rol yalnizca `resident` olabilir; apartman JWT'deki `apartmentId` claim'inden gelir.
 *  2. Daire, kullanicinin o apartmandaki AKTIF `UnitMembership` kayitlarindan cozulur.
 *     Istekte `unitId` verilirse yalnizca kendi uyeliklerinden biri olabilir; aksi 403.
 *  3. Yalnizca sakinin kendi alt carisi gorunur: kiraci -> `occupant`, malik -> `owner`
 *     (+ dairede oturuyorsa `occupant`). Cari satirlari uyelik baslangic/bitis tarihleriyle
 *     sinirlanir: yeni kiraci onceki kiracinin hareketlerini goremez.
 *  4. Kasa/banka/gelir hesaplari ve islemlerin karsi satirlari ASLA donmez; ekstre yalnizca
 *     sakinin cari hesabindaki satirlardan uretilir.
 */

// ---------------------------------------------------------------------------
// Hatalar
// ---------------------------------------------------------------------------

export type PortalErrorCode = 'forbidden' | 'not_found' | 'unit_selection_required';

const STATUS: Record<PortalErrorCode, 400 | 403 | 404> = {
  forbidden: 403,
  not_found: 404,
  unit_selection_required: 400,
};

export class PortalError extends Error {
  readonly code: PortalErrorCode;
  readonly httpStatus: 400 | 403 | 404;
  readonly details?: Record<string, unknown>;

  constructor(code: PortalErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PortalError';
    this.code = code;
    this.httpStatus = STATUS[code];
    this.details = details;
  }
}

export const PORTAL_ROLES: readonly Role[] = ['resident'];

export type PortalContext = { apartmentId: string; userId: string; role: Role };

export type PortalServiceDeps = {
  repository: PortalRepository;
  core: Pick<CoreRepository, 'getUnit' | 'getBlock' | 'getSite'>;
  now: () => Date;
};

// ---------------------------------------------------------------------------
// Gorunum tipleri (istemciye donen)
// ---------------------------------------------------------------------------

/**
 * Sakin dilinde hareket turu: ACCRUAL = borc tahakkuku, COLLECTION = tahsilat/odeme,
 * REVERSAL = duzeltme (ters kayit), OTHER = diger borc/alacak.
 */
export type StatementEntryType = 'ACCRUAL' | 'COLLECTION' | 'REVERSAL' | 'LATE_FEE' | 'OTHER';

export type StatementRow = {
  date: IsoDate;
  transactionId: string;
  kind?: TransactionKind;
  entryType: StatementEntryType;
  /** Tahsilat satirinda makbuz numarasi (ornek: MKB-000012). Odeme yontemi icin /my-receipts. */
  receiptNumber?: string;
  /** Bu satirin islemi daha sonra ters kayitla iptal edildi mi? */
  reversed?: boolean;
  description: string;
  dueDate?: IsoDate;
  debit: Kurus;
  credit: Kurus;
  /** Satir sonrasi bakiye: pozitif = borc, negatif = avans. */
  balance: Kurus;
  reversalOf?: string;
};

export type PartyStatement = {
  liableParty: LiableParty;
  label: string;
  openingBalance: Kurus;
  totalDebit: Kurus;
  totalCredit: Kurus;
  closingBalance: Kurus;
  entries: StatementRow[];
};

export type OpenDue = {
  transactionId: string;
  liableParty: LiableParty;
  description: string;
  date: IsoDate;
  dueDate: IsoDate;
  amount: Kurus;
  paid: Kurus;
  remaining: Kurus;
  overdue: boolean;
  daysOverdue: number;
  /** Deftere yazilmis gecikme tazminati kalemi (mahsupta anaparadan sonra gelir). */
  lateFee?: boolean;
};

export type ReceiptView = {
  paymentId: string;
  receiptNumber: string;
  paidAt: IsoDate;
  amount: Kurus;
  method: Payment['method'];
  liableParty: LiableParty;
  payerName?: string;
  status: 'valid' | 'reversed';
};

// Kullaniciya dogrudan gosterilen etiketler: Turkce karakterlerle.
const PARTY_LABEL: Record<LiableParty, string> = {
  owner: 'Kat Maliki Carisi',
  occupant: 'Sakin (Kiracı) Carisi',
};

const RELATION_LABEL: Record<UnitRelation, string> = { owner: 'Kat Maliki', tenant: 'Kiracı' };

// ---------------------------------------------------------------------------
// Saf yardimcilar
// ---------------------------------------------------------------------------

const receivableId = (unitId: string, party: LiableParty) => `recv-${unitId}-${party}`;
const signed = (e: Pick<LedgerEntry, 'side' | 'amount'>) => (e.side === 'debit' ? e.amount : -e.amount);

function isActiveOn(m: UnitMembership, day: IsoDate): boolean {
  return m.status === 'active' && m.startDate <= day && (!m.endDate || m.endDate >= day);
}

function inWindow(date: IsoDate, m: UnitMembership): boolean {
  return date >= m.startDate && (!m.endDate || date <= m.endDate);
}

function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function compareEntries(a: LedgerEntry, b: LedgerEntry): number {
  return (
    a.date.localeCompare(b.date) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.transactionId.localeCompare(b.transactionId) ||
    a.lineNo - b.lineNo
  );
}

/**
 * Acik aidat kalemleri: iptal (ters kayit) edilmemis tahakkuklara, iptal edilmemis
 * tahsilatlar vade sirasina gore (FIFO) mahsup edilir. Kalan alacak avans sayilir.
 */
export function allocateOpenDues(
  party: LiableParty,
  entries: LedgerEntry[],
  txById: Map<string, Transaction>,
  today: IsoDate,
): { open: OpenDue[]; advance: Kurus } {
  const reversed = new Set<string>();
  for (const e of entries) {
    const reversalOf = txById.get(e.transactionId)?.reversalOf;
    if (reversalOf) reversed.add(reversalOf);
  }

  const charges: OpenDue[] = [];
  let credit = 0;
  for (const e of entries) {
    const tx = txById.get(e.transactionId);
    if (!tx || tx.kind === 'reversal' || reversed.has(tx.transactionId)) continue;
    if (e.side === 'debit') {
      const dueDate = tx.dueDate ?? tx.date;
      charges.push({
        transactionId: tx.transactionId,
        liableParty: party,
        description: tx.description,
        date: tx.date,
        dueDate,
        amount: e.amount,
        paid: toKurus(0),
        remaining: e.amount,
        overdue: false,
        daysOverdue: 0,
        ...(tx.kind === 'late_fee' ? { lateFee: true } : {}),
      });
    } else {
      credit += e.amount;
    }
  }

  // Karar 2a: tahsilat once anaparayi (vade sirasiyla), en son gecikme tazminatini kapatir.
  charges.sort(
    (a, b) =>
      Number(a.lateFee ?? false) - Number(b.lateFee ?? false) ||
      a.dueDate.localeCompare(b.dueDate) ||
      a.date.localeCompare(b.date) ||
      a.transactionId.localeCompare(b.transactionId),
  );

  const open: OpenDue[] = [];
  for (const c of charges) {
    const applied = Math.min(credit, c.amount);
    credit -= applied;
    const remaining = c.amount - applied;
    if (remaining === 0) continue;
    const late = c.dueDate < today;
    open.push({
      ...c,
      paid: toKurus(applied),
      remaining: toKurus(remaining),
      overdue: late,
      daysOverdue: late ? daysBetween(c.dueDate, today) : 0,
    });
  }
  return { open, advance: toKurus(credit) };
}

function entryTypeOf(kind: TransactionKind | undefined): StatementEntryType {
  switch (kind) {
    case 'dues_charge':
      return 'ACCRUAL';
    case 'payment':
      return 'COLLECTION';
    case 'reversal':
      return 'REVERSAL';
    case 'late_fee':
      return 'LATE_FEE';
    default:
      return 'OTHER';
  }
}

/**
 * Sakin ozeti durumu:
 *  no_debt: hic tahakkuk yok ve bakiye sifir (Borc yok)
 *  paid:    tahakkuk var, hepsi odenmis (Odendi)
 *  pending: acik borc var, vadesi gecmemis (Bekliyor)
 *  overdue: vadesi gecmis borc var (Gecikmede)
 */
export type PortalDuesStatus = 'no_debt' | 'paid' | 'pending' | 'overdue';

function parseOptionalDate(value: string | undefined, field: string): IsoDate | undefined {
  if (value === undefined || value === '') return undefined;
  if (!isIsoDate(value)) throw new ValidationError(`${field} YYYY-MM-DD biciminde olmalidir`, field);
  return value;
}

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

type ResolvedUnit = { membership: UnitMembership; unit: Unit; parties: LiableParty[] };
type PartyLedger = { party: LiableParty; entries: LedgerEntry[] };

export function createPortalService(overrides: Partial<PortalServiceDeps> = {}) {
  const deps: PortalServiceDeps = {
    repository: portalRepository,
    core: coreRepository,
    now: () => new Date(),
    ...overrides,
  };
  const repo = deps.repository;

  const today = (): IsoDate =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());

  async function activeMemberships(ctx: PortalContext): Promise<UnitMembership[]> {
    if (!PORTAL_ROLES.includes(ctx.role)) {
      throw new PortalError('forbidden', 'Sakin portali yalnizca daire sakinlerine aciktir');
    }
    const day = today();
    const all = await repo.listMemberships(ctx.apartmentId, ctx.userId);
    // Savunma: sorgu zaten kullaniciya/tenant'a kilitli, yine de alanlar dogrulanir.
    return all.filter(
      (m) => m.userId === ctx.userId && m.apartmentId === ctx.apartmentId && isActiveOn(m, day),
    );
  }

  /** Talep edilen (veya tek) daireyi kullanicinin aktif uyelikleri arasindan cozer. */
  async function resolveUnit(ctx: PortalContext, requestedUnitId?: string): Promise<ResolvedUnit> {
    const memberships = await activeMemberships(ctx);
    if (memberships.length === 0) {
      throw new PortalError('forbidden', 'Bu apartmanda aktif daire uyeliginiz bulunmuyor');
    }

    let membership: UnitMembership | undefined;
    if (requestedUnitId !== undefined && requestedUnitId !== '') {
      const unitId = assertId(requestedUnitId, 'unitId');
      membership = memberships.find((m) => m.unitId === unitId);
      // Var olmayan ve baskasina ait daire ayni yaniti alir (daire varligi sizdirilmaz).
      if (!membership) throw new PortalError('forbidden', 'Bu daireye erisim yetkiniz yok');
    } else if (memberships.length === 1) {
      membership = memberships[0];
    } else {
      // Secici icin okunur etiketler ("A Blok · 5"); yalnizca kullanicinin KENDI daireleri.
      const units = await Promise.all(
        memberships.map(async (m) => {
          const u = await deps.core.getUnit(ctx.apartmentId, m.unitId);
          const b = u ? await deps.core.getBlock(ctx.apartmentId, u.blockId) : undefined;
          return {
            unitId: m.unitId,
            label: u ? (b ? `${b.name} · ${u.number}` : u.number) : m.unitId,
            relationLabel: RELATION_LABEL[m.relation],
          };
        }),
      );
      units.sort((a, b) => a.label.localeCompare(b.label, 'tr', { numeric: true }));
      throw new PortalError('unit_selection_required', 'Birden fazla daireniz var; unitId secin', {
        unitIds: memberships.map((m) => m.unitId).sort(),
        units,
      });
    }

    const m = membership as UnitMembership;
    const unit = await deps.core.getUnit(ctx.apartmentId, m.unitId);
    if (!unit) throw new PortalError('not_found', 'Bagimsiz bolum bulunamadi');
    return { membership: m, unit, parties: visibleParties(m) };
  }

  /** Sakinin gorebilecegi cari satirlari: kendi alt carisi + uyelik donemi. */
  async function loadLedgers(r: ResolvedUnit): Promise<{ ledgers: PartyLedger[]; txById: Map<string, Transaction> }> {
    const { unit, membership, parties } = r;
    const ledgers = await Promise.all(
      parties.map(async (party): Promise<PartyLedger> => {
        const raw = await repo.listLedgerEntries(unit.siteId, receivableId(unit.unitId, party));
        const entries = raw
          .filter(
            (e) =>
              e.siteId === unit.siteId &&
              e.accountId === receivableId(unit.unitId, party) &&
              (e.unitId === undefined || e.unitId === unit.unitId) &&
              inWindow(e.date, membership),
          )
          .sort(compareEntries);
        return { party, entries };
      }),
    );
    const ids = ledgers.flatMap((l) => l.entries.map((e) => e.transactionId));
    const txs = ids.length ? await repo.getTransactions(unit.siteId, ids) : [];
    return { ledgers, txById: new Map(txs.map((t) => [t.transactionId, t])) };
  }

  // ----- /my-unit -----

  async function getMyUnit(ctx: PortalContext, unitId?: string) {
    const resolved = await resolveUnit(ctx, unitId);
    const { unit, membership, parties } = resolved;
    const [block, site, { ledgers }, memberships] = await Promise.all([
      deps.core.getBlock(ctx.apartmentId, unit.blockId),
      deps.core.getSite(ctx.apartmentId),
      loadLedgers(resolved),
      activeMemberships(ctx),
    ]);

    const balances = ledgers.map(({ party, entries }) => {
      const balance = entries.reduce((s, e) => s + signed(e), 0);
      return {
        liableParty: party,
        label: PARTY_LABEL[party],
        balance: toKurus(balance),
        debt: toKurus(Math.max(balance, 0)),
        advance: toKurus(Math.max(-balance, 0)),
      };
    });
    const net = balances.reduce((s, b) => s + b.balance, 0);

    return {
      unit: {
        unitId: unit.unitId,
        number: unit.number,
        floor: unit.floor,
        type: unit.type,
        grossAreaM2: tenthsM2ToM2(unit.grossAreaTenthsM2),
        block: block ? { blockId: block.blockId, name: block.name } : { blockId: unit.blockId },
      },
      site: site ? { siteId: site.siteId, name: site.name } : { siteId: ctx.apartmentId },
      membership: {
        relation: membership.relation,
        relationLabel: RELATION_LABEL[membership.relation],
        residesInUnit: membership.residesInUnit,
        ownershipShare: membership.ownershipShare,
        startDate: membership.startDate,
        endDate: membership.endDate,
        visibleParties: parties,
      },
      currency: 'TRY' as const,
      balances,
      balance: toKurus(net),
      debt: toKurus(Math.max(net, 0)),
      advance: toKurus(Math.max(-net, 0)),
      /** Daire secici icin kullanicinin bu apartmandaki diger daireleri. */
      myUnitIds: memberships.map((m) => m.unitId).sort(),
    };
  }

  // ----- /my-statement -----

  async function getMyStatement(
    ctx: PortalContext,
    query: { unitId?: string; from?: string; to?: string } = {},
  ) {
    const from = parseOptionalDate(query.from, 'from');
    const to = parseOptionalDate(query.to, 'to');
    if (from && to && from > to) throw new ValidationError('from, to tarihinden sonra olamaz', 'from');

    const resolved = await resolveUnit(ctx, query.unitId);
    const [{ ledgers, txById }, payments] = await Promise.all([
      loadLedgers(resolved),
      repo.listUnitPayments(ctx.apartmentId, resolved.unit.unitId),
    ]);
    // Makbuz numarasi: tahsilat islemi -> Payment kaydi (ayni daire ve apartman).
    const paymentByTx = new Map(
      payments
        .filter((p) => p.siteId === ctx.apartmentId && p.unitId === resolved.unit.unitId)
        .map((p) => [p.transactionId, p]),
    );
    const reversedTx = new Set<string>();
    for (const tx of txById.values()) if (tx.reversalOf) reversedTx.add(tx.reversalOf);

    const accounts: PartyStatement[] = ledgers.map(({ party, entries }) => {
      let opening = 0;
      let running = 0;
      let totalDebit = 0;
      let totalCredit = 0;
      const rows: StatementRow[] = [];

      for (const e of entries) {
        if (from && e.date < from) {
          opening += signed(e);
          running = opening;
          continue;
        }
        if (to && e.date > to) break;
        running += signed(e);
        if (e.side === 'debit') totalDebit += e.amount;
        else totalCredit += e.amount;
        const tx = txById.get(e.transactionId);
        const payment = tx?.kind === 'payment' ? paymentByTx.get(e.transactionId) : undefined;
        rows.push({
          date: e.date,
          transactionId: e.transactionId,
          kind: tx?.kind,
          entryType: entryTypeOf(tx?.kind),
          ...(payment ? { receiptNumber: payment.receiptNumber } : {}),
          ...(reversedTx.has(e.transactionId) ? { reversed: true } : {}),
          description: tx?.description ?? '-',
          dueDate: tx?.dueDate,
          debit: toKurus(e.side === 'debit' ? e.amount : 0),
          credit: toKurus(e.side === 'credit' ? e.amount : 0),
          balance: toKurus(running),
          reversalOf: tx?.reversalOf,
        });
      }

      return {
        liableParty: party,
        label: PARTY_LABEL[party],
        openingBalance: toKurus(opening),
        totalDebit: toKurus(totalDebit),
        totalCredit: toKurus(totalCredit),
        closingBalance: toKurus(opening + totalDebit - totalCredit),
        entries: rows,
      };
    });

    return {
      unitId: resolved.unit.unitId,
      currency: 'TRY' as const,
      period: { from: from ?? resolved.membership.startDate, to: to ?? today() },
      accounts,
      closingBalance: toKurus(accounts.reduce((s, a) => s + a.closingBalance, 0)),
    };
  }

  // ----- /my-summary -----

  /**
   * Ana sayfa / Borclarim ust karti: guncel borc, toplam tahakkuk, toplam odenen, gecikme
   * ve durum rozeti. Ters kayitla iptal edilen islemler (ve ters kayitlarin kendisi)
   * toplamlara katilmaz; bakiye ise defterin kendisidir (iptaller zaten net sifir).
   */
  async function getMySummary(ctx: PortalContext, unitId?: string) {
    const resolved = await resolveUnit(ctx, unitId);
    const { unit, membership } = resolved;
    const [{ ledgers, txById }, payments, block, site] = await Promise.all([
      loadLedgers(resolved),
      repo.listUnitPayments(ctx.apartmentId, unit.unitId),
      deps.core.getBlock(ctx.apartmentId, unit.blockId),
      deps.core.getSite(ctx.apartmentId),
    ]);
    const lateFeeRate = site?.settings.lateFeeMonthlyBasisPoints ?? DEFAULT_LATE_FEE_BASIS_POINTS;
    const day = today();

    const cancelled = new Set<string>();
    for (const tx of txById.values()) {
      if (tx.reversalOf) {
        cancelled.add(tx.reversalOf);
        cancelled.add(tx.transactionId);
      }
    }

    let balance = 0;
    let totalCharged = 0;
    let totalPaid = 0;
    let accruedLateFee = 0;
    for (const { entries } of ledgers) {
      const feeCharges: FeeCharge[] = [];
      const feeCredits: FeeCredit[] = [];
      let postedFees = 0;
      for (const e of entries) {
        balance += signed(e);
        if (cancelled.has(e.transactionId)) continue;
        const tx = txById.get(e.transactionId);
        const kind = tx?.kind;
        if (e.side === 'debit' && (kind === 'dues_charge' || kind === 'late_fee')) totalCharged += e.amount;
        if (e.side === 'credit' && kind === 'payment') totalPaid += e.amount;
        if (e.side === 'debit' && kind === 'dues_charge') feeCharges.push({ id: e.transactionId, dueDate: tx?.dueDate ?? e.date, amount: e.amount });
        else if (e.side === 'debit' && kind === 'late_fee') postedFees += e.amount;
        else if (e.side === 'credit') feeCredits.push({ date: e.date, amount: e.amount });
      }
      if (lateFeeRate > 0) accruedLateFee += unpostedLateFee({ charges: feeCharges, credits: feeCredits, postedFees }, lateFeeRate, day);
    }

    const open = ledgers.flatMap(({ party, entries }) => allocateOpenDues(party, entries, txById, day).open);
    const overdueAmount = open.filter((o) => o.overdue).reduce((s, o) => s + o.remaining, 0);
    const upcoming = open.filter((o) => !o.overdue).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
    const oldestOverdue = open.filter((o) => o.overdue).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];

    const debt = Math.max(balance, 0);
    const status: PortalDuesStatus =
      overdueAmount > 0 ? 'overdue' : debt > 0 ? 'pending' : totalCharged > 0 ? 'paid' : 'no_debt';

    const parties = new Set(resolved.parties);
    const lastPayment = payments
      .filter(
        (p) =>
          p.siteId === ctx.apartmentId &&
          p.unitId === unit.unitId &&
          parties.has(p.liableParty) &&
          inWindow(p.paidAt, membership) &&
          !cancelled.has(p.transactionId),
      )
      .sort((a, b) => b.paidAt.localeCompare(a.paidAt) || b.receiptNumber.localeCompare(a.receiptNumber))[0];

    return {
      unitId: unit.unitId,
      unitLabel: block ? `${block.name} · ${unit.number}` : unit.number,
      relationLabel: RELATION_LABEL[membership.relation],
      currency: 'TRY' as const,
      asOf: day,
      status,
      balance: toKurus(balance),
      debt: toKurus(debt),
      advance: toKurus(Math.max(-balance, 0)),
      totalCharged: toKurus(totalCharged),
      totalPaid: toKurus(totalPaid),
      overdueAmount: toKurus(overdueAmount),
      /** Islemis, henuz deftere yazilmamis kistelyevm gecikme tazminati (bugun itibariyla). */
      accruedLateFee: toKurus(accruedLateFee),
      lateFeeMonthlyBasisPoints: lateFeeRate,
      oldestOverdueDueDate: oldestOverdue?.dueDate,
      daysOverdue: oldestOverdue?.daysOverdue ?? 0,
      openCount: open.length,
      nextDue: upcoming ? { dueDate: upcoming.dueDate, amount: upcoming.remaining, description: upcoming.description } : undefined,
      lastPayment: lastPayment
        ? { paidAt: lastPayment.paidAt, amount: lastPayment.amount, receiptNumber: lastPayment.receiptNumber }
        : undefined,
    };
  }

  // ----- /my-dues -----

  async function getMyDues(ctx: PortalContext, unitId?: string) {
    const resolved = await resolveUnit(ctx, unitId);
    const { ledgers, txById } = await loadLedgers(resolved);
    const day = today();

    const perParty = ledgers.map(({ party, entries }) => allocateOpenDues(party, entries, txById, day));
    const items = perParty
      .flatMap((p) => p.open)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.transactionId.localeCompare(b.transactionId));

    const totalOpen = items.reduce((s, i) => s + i.remaining, 0);
    const overdue = items.filter((i) => i.overdue).reduce((s, i) => s + i.remaining, 0);
    const advance = perParty.reduce((s, p) => s + p.advance, 0);

    return {
      unitId: resolved.unit.unitId,
      currency: 'TRY' as const,
      asOf: day,
      summary: {
        totalOpen: toKurus(totalOpen),
        overdueAmount: toKurus(overdue),
        advance: toKurus(advance),
        openCount: items.length,
      },
      items,
    };
  }

  // ----- /my-receipts -----

  async function getMyReceipts(ctx: PortalContext, unitId?: string) {
    const resolved = await resolveUnit(ctx, unitId);
    const { unit, membership, parties } = resolved;
    const [payments, { txById }] = await Promise.all([
      repo.listUnitPayments(ctx.apartmentId, unit.unitId),
      loadLedgers(resolved),
    ]);

    const reversed = new Set<string>();
    for (const tx of txById.values()) if (tx.reversalOf) reversed.add(tx.reversalOf);

    const items: ReceiptView[] = payments
      .filter(
        (p) =>
          p.siteId === ctx.apartmentId &&
          p.unitId === unit.unitId &&
          parties.includes(p.liableParty) &&
          inWindow(p.paidAt, membership),
      )
      .sort((a, b) => b.paidAt.localeCompare(a.paidAt) || b.receiptNumber.localeCompare(a.receiptNumber))
      .map((p) => ({
        paymentId: p.paymentId,
        receiptNumber: p.receiptNumber,
        paidAt: p.paidAt,
        amount: p.amount,
        method: p.method,
        liableParty: p.liableParty,
        payerName: p.payerName,
        status: reversed.has(p.transactionId) ? ('reversed' as const) : ('valid' as const),
      }));

    return { unitId: unit.unitId, currency: 'TRY' as const, items };
  }

  // ----- /announcements -----

  async function getAnnouncements(ctx: PortalContext, unitId?: string) {
    const { unit } = await resolveUnit(ctx, unitId);
    const nowIso = deps.now().toISOString();
    const all = await repo.listPublishedAnnouncements(ctx.apartmentId);

    const items = all
      .filter(
        (a) =>
          a.apartmentId === ctx.apartmentId &&
          a.status === 'published' &&
          Boolean(a.approvedAt) &&
          a.publishAt <= nowIso &&
          (!a.expiresAt || a.expiresAt > nowIso) &&
          (!a.blockIds?.length || a.blockIds.includes(unit.blockId)),
      )
      .sort((a, b) => b.publishAt.localeCompare(a.publishAt))
      .map((a) => ({
        announcementId: a.announcementId,
        title: a.title,
        body: a.body,
        publishAt: a.publishAt,
        expiresAt: a.expiresAt,
      }));

    return { items };
  }

  return { resolveUnit, getMyUnit, getMySummary, getMyStatement, getMyDues, getMyReceipts, getAnnouncements };
}

export type PortalService = ReturnType<typeof createPortalService>;
