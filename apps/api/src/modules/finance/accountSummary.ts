/**
 * P1-a: alt cari (sakin/malik alacak hesabi) OZETI - saf fonksiyonlar, I/O yok.
 *
 * Site geneli raporlar (Genel Bakis KPI, `dues-status`, ayrilan cariler, hatirlatmalar, gecikme
 * tazminati kesinlestirmesi, donem kapanisi uyarisi) bir alt carinin tum gecmisini degil, bu
 * ozeti okur. Ozet, `subledger.ts` + `lateFee.ts` kurallariyla TAM hesap gecmisinden uretilir ve
 * yalnizca "bugune bagli olmayan" sonuclari tasir:
 *
 *  - FIFO acik kalemleri (`allocate` tarihten bagimsizdir; vade < bugun ise gecikmistir),
 *  - kistelyevm zaman cizelgesi (`lateFeeTimeline`): her asOf icin tazminat birebir hesaplanir,
 *  - toplamlar (tahakkuk, tahsilat, bakiye, deftere yazilmis tazminat, son odeme).
 *
 * Cizelgenin ufuktan (`horizon`) once kapanmis segmentleri tek bir kurus-gun sabitine katlanir;
 * ozet `asOf >= horizon` olan her sorgu icin kesindir. Saklanan ozet hesabin `version` alanina
 * MUHURLUDUR (bkz. `accountSummaryStore.ts`): defter yazimi hesabin surumunu ayni atomik
 * TransactWriteItems icinde arttirdigi icin, surumu tutmayan ozet asla kullanilmaz.
 */
import type { IsoDate, LiableParty, TableKeys, Unit } from '../core/types.js';
import { dayNumber, feeOfPrincipalDays, lateFeeTimeline, principalDaysAt } from './lateFee.js';
import type { PartyDues, UnitDuesView, FormerAccountView, DueReminder, DueReminderKind, DuesStatus } from './reports.js';
import { type AccountLine, allocate, feeInputsOf, readSubledger } from './subledger.js';
import { type Account, isPrimaryReceivableId } from './types.js';

/** Ozet bicimi degisirse artirilir: eski surumlu ozetler okunmaz, yeniden uretilir. */
export const ACCOUNT_SUMMARY_SCHEMA = 1;
/** Saklanan ozetin gecerli oldugu en eski asOf: hesaplama gununden bu kadar gun once. */
export const SUMMARY_HORIZON_DAYS = 400;

/** [kurus, baslangic gunu (haric), bitis gunu (dahil) | null = acik] */
export type SummarySegment = [number, number, number | null];

export type DuesCore = {
  /** Hesapta (iptal edilmis olsa da) en az bir defter satiri var mi? */
  hasLines: boolean;
  /** Tahakkuk toplami (yapilandirma kalemleri haric; asil kalemlerin yerini alirlar). */
  charged: number;
  /** Havuz alacaklari (tahsilat vb.; avans mahsubundan sonra). */
  paid: number;
  /** Dikkate alinan satirlarin bakiyesi (borc - alacak). */
  balance: number;
  /** Deftere yazilmis (iptal edilmemis) gecikme tazminati toplami. */
  postedFees: number;
  lastPaymentDate?: IsoDate;
  /** FIFO acik kalemleri (kalan > 0), `allocate` sirasinda. */
  open: { dueDate: IsoDate; remaining: number }[];
  fee: {
    /** Bu tarihten once asOf ile sorgulanamaz (yoksa her asOf gecerli). */
    horizon?: IsoDate;
    /** Ufuktan once kapanmis segmentlerin kurus-gun toplami (BigInt, ondalik metin). */
    fixed: string;
    segments: SummarySegment[];
    /** Ufuk (dahil) ve oncesi tarihli deftere yazilmis tazminat. */
    postedBefore: number;
    /** Ufuktan sonra tarihli deftere yazilmis tazminatlar. */
    posted: [IsoDate, number][];
  };
};

/** Saklanan ozet (`PK = APT#<id>`, `SK = FSUM#<accountId>`). Turetilmis veridir; defter degildir. */
export type AccountSummaryItem = TableKeys & {
  entityType: 'ACCOUNT_SUMMARY';
  schema: number;
  siteId: string;
  accountId: string;
  /** Ozetin uretildigi andaki hesap surumu (`Account.version`). */
  sourceVersion: number;
  computedAt: string;
  core: DuesCore;
};

const addDays = (d: IsoDate, n: number): IsoDate => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Saklanacak ozetin ufku: hesaplama gunu - SUMMARY_HORIZON_DAYS (istenen asOf daha eskiyse o). */
export function summaryHorizon(today: IsoDate, asOf?: IsoDate): IsoDate {
  const h = addDays(today, -SUMMARY_HORIZON_DAYS);
  return asOf && asOf < h ? asOf : h;
}

/**
 * Bir alt carinin satirlarindan ozet. `cancelled` verilmezse satirlarin islemlerinden turetilir
 * (ters kayit ayni hesaplara yazildigi icin site geneli kume ile ayni sonuc). `horizon` verilmezse
 * hic segment katlanmaz (her asOf icin gecerli).
 */
export function summarizeLines(lines: readonly AccountLine[], cancelled?: ReadonlySet<string>, horizon?: IsoDate): DuesCore {
  const sub = cancelled ? readSubledger(lines, cancelled) : readSubledger(lines);
  // Acik kalemler tarihten bagimsizdir (yalnizca `overdue` bugune baglidir; okurken hesaplanir).
  const { open } = allocate(sub, '9999-12-31');
  const timeline = lateFeeTimeline(feeInputsOf(sub));
  const horizonDay = horizon ? dayNumber(horizon) : undefined;
  let fixed = 0n;
  const segments: SummarySegment[] = [];
  for (const s of timeline.segments) {
    if (horizonDay !== undefined && s.end !== null && s.end <= horizonDay) {
      // asOf >= ufuk >= bitis: katki sabittir.
      const days = s.end - s.start;
      if (days > 0 && s.amount > 0) fixed += BigInt(s.amount) * BigInt(days);
      continue;
    }
    segments.push([s.amount, s.start, s.end]);
  }
  let postedBefore = 0;
  const posted: [IsoDate, number][] = [];
  for (const c of sub.charges) {
    if (c.txKind !== 'late_fee') continue;
    if (horizon && c.date <= horizon) postedBefore += c.amount;
    else posted.push([c.date, c.amount]);
  }
  posted.sort((a, b) => a[0].localeCompare(b[0]));
  let lastPaymentDate: IsoDate | undefined;
  for (const c of sub.credits) {
    if (c.txKind === 'payment' && (!lastPaymentDate || c.date > lastPaymentDate)) lastPaymentDate = c.date;
  }
  return {
    hasLines: lines.length > 0,
    charged: sub.charges.filter((c) => c.txKind !== 'restructure').reduce((s, c) => s + c.amount, 0),
    paid: sub.credits.reduce((s, c) => s + c.amount, 0),
    balance: sub.balance,
    postedFees: sub.postedFees,
    ...(lastPaymentDate ? { lastPaymentDate } : {}),
    open: open.map((c) => ({ dueDate: c.dueDate, remaining: c.remaining })),
    fee: { ...(horizon ? { horizon } : {}), fixed: fixed.toString(), segments, postedBefore, posted },
  };
}

/** Ozet bu asOf icin kullanilabilir mi (ufuk kosulu)? */
export const coreServes = (core: DuesCore, asOf: IsoDate): boolean => !core.fee.horizon || core.fee.horizon <= asOf;

function assertServes(core: DuesCore, asOf: IsoDate): void {
  if (!coreServes(core, asOf)) throw new Error(`Ozet ufku (${core.fee.horizon}) ${asOf} icin gecersiz`);
}

/** `asOf` itibariyla toplam (yazilmis + yazilmamis) tazminat. */
export function feeAt(core: DuesCore, monthlyBasisPoints: number, asOf: IsoDate): number {
  assertServes(core, asOf);
  const pd = BigInt(core.fee.fixed) + principalDaysAt(core.fee.segments.map(([amount, start, end]) => ({ amount, start, end })), dayNumber(asOf));
  return feeOfPrincipalDays(pd, monthlyBasisPoints);
}

/** `date` (dahil) ve oncesi tarihli deftere yazilmis tazminat. */
export function postedFeesThrough(core: DuesCore, date: IsoDate): number {
  assertServes(core, date);
  return core.fee.postedBefore + core.fee.posted.reduce((s, [d, a]) => (d <= date ? s + a : s), 0);
}

/**
 * `unpostedLateFee(feeInputsOf(sub), bps, asOf)` ile birebir: `toplam(asOf) - yazilmis`, eksi 0.
 * `postedThrough` verilirse yalnizca o tarihe kadar yazilmislar dusulur (donem kapanisi uyarisi).
 */
export function unpostedFeeOf(core: DuesCore, monthlyBasisPoints: number, asOf: IsoDate, postedThrough?: IsoDate): number {
  const posted = postedThrough === undefined ? core.postedFees : postedFeesThrough(core, postedThrough);
  return Math.max(feeAt(core, monthlyBasisPoints, asOf) - posted, 0);
}

// ---------------------------------------------------------------------------
// Rapor kurucular (reports.ts sarmalayicilari ve servis ayni yolu kullanir)
// ---------------------------------------------------------------------------

function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function partyDuesOf(core: DuesCore, today: IsoDate, lateFeeBasisPoints: number): PartyDues {
  const overdue = core.open.filter((c) => c.dueDate < today).reduce((s, c) => s + c.remaining, 0);
  const first = core.open[0];
  return {
    charged: core.charged,
    paid: core.paid,
    balance: core.balance,
    overdue,
    ...(first ? { oldestUnpaidDueDate: first.dueDate } : {}),
    lateFee: lateFeeBasisPoints > 0 ? unpostedFeeOf(core, lateFeeBasisPoints, today) : 0,
  };
}

export type CoreEntry = { accountId: string; unitId: string; party: LiableParty; main: boolean; core: DuesCore };

/** Alacak hesaplarindan rapor girdileri (yalnizca satiri olanlar; `buildDuesStatus` ile ayni kume). */
export function coreEntries(accounts: readonly Account[], cores: ReadonlyMap<string, DuesCore>): CoreEntry[] {
  const out: CoreEntry[] = [];
  for (const a of accounts) {
    if (a.type !== 'receivable' || !a.unitId || !a.liableParty) continue;
    const core = cores.get(a.accountId);
    if (!core?.hasLines) continue;
    out.push({ accountId: a.accountId, unitId: a.unitId, party: a.liableParty, main: isPrimaryReceivableId(a.accountId, a.unitId, a.liableParty), core });
  }
  return out;
}

export function buildDuesStatusFromCores(units: readonly Unit[], entries: readonly CoreEntry[], today: IsoDate, lateFeeBasisPoints = 0): UnitDuesView[] {
  const none = (): PartyDues => ({ charged: 0, paid: 0, balance: 0, overdue: 0, lateFee: 0 });
  const add = (a: PartyDues, b: PartyDues): PartyDues => {
    const oldest = [a.oldestUnpaidDueDate, b.oldestUnpaidDueDate].filter((d): d is IsoDate => Boolean(d)).sort()[0];
    return {
      charged: a.charged + b.charged,
      paid: a.paid + b.paid,
      balance: a.balance + b.balance,
      overdue: a.overdue + b.overdue,
      ...(oldest ? { oldestUnpaidDueDate: oldest } : {}),
      lateFee: a.lateFee + b.lateFee,
    };
  };
  type Slot = { owner: PartyDues; occupant: PartyDues; former?: PartyDues; lastPaymentDate?: IsoDate };
  const perUnit = new Map<string, Slot>();
  const slot = (unitId: string) => {
    let s = perUnit.get(unitId);
    if (!s) {
      s = { owner: none(), occupant: none() };
      perUnit.set(unitId, s);
    }
    return s;
  };

  for (const e of entries) {
    const dues = partyDuesOf(e.core, today, lateFeeBasisPoints);
    const s = slot(e.unitId);
    if (e.main) {
      // Paydas alt carileri (Finans 2.1) dairenin malik tarafinda toplanir.
      s[e.party] = add(s[e.party], dues);
      const last = e.core.lastPaymentDate;
      if (last && (!s.lastPaymentDate || last > s.lastPaymentDate)) s.lastPaymentDate = last;
    } else {
      // Ayrilan sakin/malik carileri: daire durumuna karismaz, ayri gosterilir.
      s.former = add(s.former ?? none(), dues);
    }
  }

  return units
    .filter((u) => u.status === 'active')
    .map((u) => {
      const s = perUnit.get(u.unitId) ?? { owner: none(), occupant: none() };
      const { owner, occupant } = s;
      const balance = owner.balance + occupant.balance;
      const overdue = owner.overdue + occupant.overdue;
      const oldest = [owner, occupant]
        .filter((p) => p.overdue > 0 && p.oldestUnpaidDueDate)
        .map((p) => p.oldestUnpaidDueDate as IsoDate)
        .sort()[0];
      const status: DuesStatus =
        owner.charged + occupant.charged === 0 && balance === 0
          ? 'none'
          : overdue > 0
            ? 'overdue'
            : balance > 0
              ? 'pending'
              : balance < 0
                ? 'advance'
                : 'paid';
      return {
        unitId: u.unitId,
        unitNumber: u.number,
        blockId: u.blockId,
        owner,
        occupant,
        balance,
        overdue,
        lateFee: owner.lateFee + occupant.lateFee,
        daysOverdue: oldest ? Math.max(daysBetween(oldest, today), 0) : 0,
        status,
        lastPaymentDate: s.lastPaymentDate,
        ...(s.former ? { former: s.former } : {}),
      };
    });
}

export function buildFormerAccountsFromCores(
  accounts: readonly Account[],
  units: readonly Unit[],
  coreOf: (accountId: string) => DuesCore,
  today: IsoDate,
  lateFeeBasisPoints = 0,
  includeSettled = false,
): FormerAccountView[] {
  const unitById = new Map(units.map((u) => [u.unitId, u]));
  const former = accounts.filter(
    (a) => a.type === 'receivable' && a.unitId && a.liableParty && !isPrimaryReceivableId(a.accountId, a.unitId, a.liableParty),
  );
  return former
    .filter((a) => includeSettled || a.balance !== 0)
    .map((a) => {
      const core = coreOf(a.accountId);
      const overdue = core.open.filter((c) => c.dueDate < today);
      const oldest = overdue[0]?.dueDate ?? core.open[0]?.dueDate;
      const unit = unitById.get(a.unitId as string);
      return {
        accountId: a.accountId,
        name: a.name,
        unitId: a.unitId as string,
        ...(unit ? { unitNumber: unit.number, blockId: unit.blockId } : {}),
        liableParty: a.liableParty as LiableParty,
        ...(a.closureId ? { closureId: a.closureId } : {}),
        ...(a.holder ? { holder: a.holder } : {}),
        balance: a.balance,
        debt: Math.max(a.balance, 0),
        advance: Math.max(-a.balance, 0),
        overdue: overdue.reduce((s, c) => s + c.remaining, 0),
        ...(oldest ? { oldestUnpaidDueDate: oldest } : {}),
        daysOverdue: overdue[0] ? daysBetween(overdue[0].dueDate, today) : 0,
        lateFee: lateFeeBasisPoints > 0 ? unpostedFeeOf(core, lateFeeBasisPoints, today) : 0,
        ...(core.lastPaymentDate ? { lastPaymentDate: core.lastPaymentDate } : {}),
      };
    })
    .sort((x, y) => (x.unitNumber ?? x.unitId).localeCompare(y.unitNumber ?? y.unitId, 'tr', { numeric: true }) || x.accountId.localeCompare(y.accountId));
}

const shiftDate = (d: IsoDate, days: number): IsoDate => addDays(d, days);

export function buildDueRemindersFromCores(
  entries: readonly Pick<CoreEntry, 'accountId' | 'unitId' | 'party' | 'core'>[],
  date: IsoDate,
  holders: ReadonlyMap<string, string> = new Map(),
): DueReminder[] {
  const targets = new Map<IsoDate, DueReminderKind>([
    [shiftDate(date, 3), 'upcoming'],
    [shiftDate(date, -1), 'overdue_1'],
    [shiftDate(date, -7), 'overdue_7'],
  ]);
  const out: DueReminder[] = [];
  for (const acc of [...entries].sort(
    (a, b) => a.unitId.localeCompare(b.unitId) || a.party.localeCompare(b.party) || a.accountId.localeCompare(b.accountId),
  )) {
    const userId = holders.get(acc.accountId);
    const byDue = new Map<IsoDate, number>();
    for (const c of acc.core.open) {
      if (targets.has(c.dueDate)) byDue.set(c.dueDate, (byDue.get(c.dueDate) ?? 0) + c.remaining);
    }
    for (const [dueDate, amount] of [...byDue.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      out.push({ unitId: acc.unitId, liableParty: acc.party, kind: targets.get(dueDate) as DueReminderKind, dueDate, amount, ...(userId ? { userId } : {}) });
    }
  }
  return out;
}
