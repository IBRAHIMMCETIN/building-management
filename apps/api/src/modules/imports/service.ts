import { randomUUID } from 'node:crypto';
import type { Role } from '../../auth/claims.js';
import { DataAccessError } from '../../config/dynamodb.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import { CoreError, type CoreService, createCoreService, sumLandShares } from '../core/service.js';
import type { IsoDate, LandShare, Unit } from '../core/types.js';
import { ValidationError, asObject, assertId, optString, reqString } from '../core/validation.js';
import { cancelledTransactions } from '../finance/lateFee.js';
import { type FinanceRepository, financeRepository } from '../finance/repository.js';
import { FinanceError, type FinanceService } from '../finance/service.js';
import { type MembershipService, createMembershipService } from '../memberships/service.js';
import { type PersonRepository, personRepository } from '../residents/repository.js';
import { ResidentsError, type ResidentsService } from '../residents/service.js';
import {
  type BalanceRow,
  type BalanceRowInput,
  MAX_CHUNK,
  MAX_ROWS,
  type Parsed,
  type PersonRow,
  type PersonRowInput,
  type RowError,
  type UnitRow,
  type UnitRowInput,
  parseBalanceRow,
  parseDate,
  parsePersonRow,
  parseSignedKurus,
  parseUnitRow,
  unitKeyOf,
} from './parse.js';
import { type ImportRepository, importKeys, importRepository } from './repository.js';
import type { ImportCounts, ImportItem, ImportJob, ImportKind, ImportOutcome } from './types.js';

/**
 * Toplu veri aktarimi (Excel/CSV): daireler, kisiler (uyelik) ve acilis bakiyeleri.
 *
 *  1. preview: hicbir sey yazmadan satir satir dogrular (dosya ici tekrarlar, mevcut kayitlar,
 *     arsa payi toplami, daire baglantilari).
 *  2. start -> rows (en fazla 25 satirlik parcalar, sirayla daireler -> kisiler -> bakiyeler)
 *     -> funds (kasa/banka) -> complete. Her satir bir ImportItem kaydiyla idempotenttir:
 *     baglanti kopup ayni parca tekrar gonderilirse ikinci kez yazilmaz.
 *     Yazimlar mevcut servislerle yapilir (core, residents/memberships, finance); is kurallari
 *     tek yerde kalir.
 *  3. invitations: aktarimda kullanicilar SESSIZ olusturulur (karar 1a); yonetici kontrol
 *     ettikten sonra davet e-postalari parcalar halinde gonderilir.
 *  4. rollback: acilis bakiyeleri TERS KAYITLA iptal edilir (defter silinmez), uyelikler
 *     sonlandirilir, aktarimla acilan ve baska hareketi olmayan daireler pasife alinir.
 */

export type ImportsContext = { apartmentId: string; userId: string; role: Role };

export class ImportError extends Error {
  readonly code: 'not_found' | 'conflict';
  readonly httpStatus: 404 | 409;
  constructor(code: 'not_found' | 'conflict', message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.httpStatus = code === 'not_found' ? 404 : 409;
  }
}

export type ImportsServiceDeps = {
  repository: ImportRepository;
  core: Pick<CoreService, 'createBlock' | 'createUnit' | 'deactivateUnit'>;
  coreRepo: Pick<CoreRepository, 'getSite' | 'listBlocks' | 'listUnits'>;
  residents: Pick<ResidentsService, 'invite' | 'resendInvitation'>;
  memberships: Pick<MembershipService, 'list' | 'deactivate'>;
  people: Pick<PersonRepository, 'list'>;
  finance: Pick<FinanceService, 'postOpeningBalance' | 'postOpeningFunds' | 'reverseTransaction'>;
  financeRepo: Pick<FinanceRepository, 'listTransactions'>;
  now: () => Date;
  newId: () => string;
};

export type RowStatus = 'create' | 'exists' | 'error';
export type PreviewRow = { sheet: 'units' | 'people' | 'balances'; row: number; label: string; status: RowStatus; errors?: RowError[] };

const INVITE_BATCH = 20;
const ROLLBACK_BATCH = 40;

type Sheets = { units: UnitRowInput[]; people: PersonRowInput[]; balances: BalanceRowInput[] };

const cell = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;

function readRows<T extends { row: number }>(value: unknown, field: string, keys: readonly string[]): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} bir dizi olmalidir`, field);
  return value.map((raw, i) => {
    const o = asObject(raw, `${field}[${i}]`);
    const row = typeof o.row === 'number' && Number.isInteger(o.row) && o.row > 0 ? o.row : i + 2;
    const out: Record<string, unknown> = { row };
    for (const k of keys) out[k] = cell(o[k]);
    return out as T;
  });
}

const UNIT_KEYS = ['block', 'number', 'floor', 'type', 'area', 'landShare'] as const;
const PERSON_KEYS = ['block', 'number', 'fullName', 'email', 'relation', 'residesInUnit', 'startDate', 'share'] as const;
const BALANCE_KEYS = ['block', 'number', 'party', 'amount', 'dueDate', 'description'] as const;

function readSheets(o: Record<string, unknown>, max: number): Sheets {
  const sheets: Sheets = {
    units: readRows<UnitRowInput>(o.units, 'units', UNIT_KEYS),
    people: readRows<PersonRowInput>(o.people, 'people', PERSON_KEYS),
    balances: readRows<BalanceRowInput>(o.balances, 'balances', BALANCE_KEYS),
  };
  const total = sheets.units.length + sheets.people.length + sheets.balances.length;
  if (total > max) throw new ValidationError(`Tek seferde en fazla ${max} satir gonderilebilir`, 'rows');
  return sheets;
}

const emptyCounts = (): ImportCounts => ({
  unit: { created: 0, exists: 0, error: 0 },
  person: { created: 0, exists: 0, error: 0 },
  balance: { created: 0, exists: 0, error: 0 },
  funds: { created: 0, exists: 0, error: 0 },
});

/** Satir hatasi olarak kaydedilecek (kalici) is kurali hatalari; digerleri tekrar denenir. */
function businessMessage(err: unknown): string | undefined {
  if (err instanceof ValidationError || err instanceof CoreError || err instanceof FinanceError) return err.message;
  if (err instanceof ResidentsError && err.code === 'invalid_email') return err.message;
  return undefined;
}

export function createImportsService(overrides: Partial<ImportsServiceDeps> & Pick<ImportsServiceDeps, 'residents' | 'finance'>) {
  const deps: ImportsServiceDeps = {
    repository: importRepository,
    core: createCoreService(),
    coreRepo: coreRepository,
    memberships: createMembershipService(),
    people: personRepository,
    financeRepo: financeRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.repository;
  const today = (): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());
  const stamp = () => deps.now().toISOString();

  function parseAsOf(value: unknown): IsoDate {
    const d = parseDate(typeof value === 'string' ? value : undefined);
    if (!d) throw new ValidationError('Devir tarihi (asOfDate) gerekli: YYYY-AA-GG', 'asOfDate');
    if (d > today()) throw new ValidationError('Devir tarihi gelecekte olamaz', 'asOfDate');
    return d;
  }

  async function snapshot(apartmentId: string) {
    const [blocks, units] = await Promise.all([deps.coreRepo.listBlocks(apartmentId), deps.coreRepo.listUnits(apartmentId)]);
    const blockName = new Map(blocks.map((b) => [b.blockId, b.name]));
    const unitsByKey = new Map<string, Unit>();
    for (const u of units) unitsByKey.set(unitKeyOf(blockName.get(u.blockId) ?? '', u.number), u);
    return { blocks, units, unitsByKey };
  }

  /**
   * Defterde iptal edilmemis devir bakiyeleri: `${unitId}|${party}` -> yazan aktarimlarin
   * batchId'leri. Ayni dosya yeni bir aktarim kimligiyle tekrar yuklenirse (sekme kapandi,
   * yeniden baslatildi) devir borclari ikinci kez yazilmasin diye kullanilir.
   */
  async function postedOpenings(apartmentId: string): Promise<Map<string, Set<string | undefined>>> {
    const { items: ledger } = await deps.financeRepo.listTransactions(apartmentId);
    const cancelled = cancelledTransactions(ledger);
    const out = new Map<string, Set<string | undefined>>();
    for (const tx of ledger) {
      if (tx.kind !== 'opening_balance' || cancelled.has(tx.transactionId)) continue;
      for (const line of tx.lines) {
        if (!line.unitId || !line.liableParty) continue;
        const key = `${line.unitId}|${line.liableParty}`;
        const batches = out.get(key) ?? new Set<string | undefined>();
        batches.add(tx.batchId);
        out.set(key, batches);
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Onizleme (yazmaz)
  // -------------------------------------------------------------------------

  async function preview(ctx: ImportsContext, body: unknown) {
    const o = asObject(body);
    const asOfDate = parseAsOf(o.asOfDate);
    const sheets = readSheets(o, MAX_ROWS);
    const { blocks, units, unitsByKey } = await snapshot(ctx.apartmentId);
    const rows: PreviewRow[] = [];
    const globalErrors: string[] = [];
    const label = (r: { block?: string; number?: string }) => `${r.block ?? ''} · ${r.number ?? ''}`.trim();

    const push = <T>(sheet: PreviewRow['sheet'], input: { row: number; block?: string; number?: string }, parsed: Parsed<T>, status: (v: T) => RowStatus | RowError) => {
      if (!parsed.ok) {
        rows.push({ sheet, row: input.row, label: label(input), status: 'error', errors: parsed.errors });
        return undefined;
      }
      const s = status(parsed.value);
      if (typeof s === 'object') rows.push({ sheet, row: input.row, label: label(input), status: 'error', errors: [s] });
      else rows.push({ sheet, row: input.row, label: label(input), status: s });
      return typeof s === 'object' ? undefined : parsed.value;
    };

    // --- Daireler ---
    const seen = new Set<string>();
    const fileUnits = new Set<string>();
    const newShares: LandShare[] = [];
    for (const input of sheets.units) {
      const v = push<UnitRow>('units', input, parseUnitRow(input), (u) => {
        if (seen.has(u.key)) return { field: 'number', message: 'Bu blok/daire dosyada birden fazla kez geçiyor' };
        seen.add(u.key);
        const existing = unitsByKey.get(u.key.slice(5));
        if (existing?.status === 'inactive') return { field: 'number', message: 'Bu numarada pasif bir daire var; önce onu etkinleştirin veya numarayı değiştirin' };
        return existing ? 'exists' : 'create';
      });
      if (v) {
        fileUnits.add(v.key.slice(5));
        if (!unitsByKey.has(v.key.slice(5)) && v.landShare) newShares.push(v.landShare);
      }
    }
    const shares = [...units.filter((u) => u.status === 'active' && u.landShare).map((u) => u.landShare as LandShare), ...newShares];
    const total = sumLandShares(shares);
    if (total.numerator > total.denominator) globalErrors.push('Arsa paylarının toplamı 1’i aşıyor (mevcut daireler + dosya).');

    const knownUnit = (unitKey: string) => {
      const existing = unitsByKey.get(unitKey);
      return (existing && existing.status === 'active') || fileUnits.has(unitKey);
    };

    // --- Kisiler ---
    const [people, memberships] = await Promise.all([
      deps.people.list(ctx.apartmentId),
      deps.memberships.list({ apartmentId: ctx.apartmentId, userId: ctx.userId }, { status: 'active' }),
    ]);
    const userByEmail = new Map(people.map((p) => [p.email.toLowerCase(), p.userId]));
    const unitIdOf = (unitKey: string) => unitsByKey.get(unitKey)?.unitId;
    const seenPeople = new Set<string>();
    const tenantsInFile = new Set<string>();
    for (const input of sheets.people) {
      push<PersonRow>('people', input, parsePersonRow(input, asOfDate), (p) => {
        if (!knownUnit(p.unitKey)) return { field: 'number', message: 'Daire bulunamadı (Daireler sayfasında veya sistemde yok)' };
        if (seenPeople.has(p.key)) return { field: 'email', message: 'Bu kişi bu daireye dosyada birden fazla kez atanmış' };
        seenPeople.add(p.key);
        const userId = userByEmail.get(p.email);
        const unitId = unitIdOf(p.unitKey);
        if (userId && unitId && memberships.some((m) => m.userId === userId && m.unitId === unitId)) return 'exists';
        if (p.relation === 'tenant') {
          if (tenantsInFile.has(p.unitKey)) return { field: 'relation', message: 'Aynı daireye dosyada birden fazla kiracı atanmış' };
          tenantsInFile.add(p.unitKey);
          if (unitId && memberships.some((m) => m.unitId === unitId && m.relation === 'tenant')) {
            return { field: 'relation', message: 'Bu dairede zaten aktif bir kiracı var' };
          }
        }
        return 'create';
      });
    }

    // --- Acilis bakiyeleri ---
    const seenBalances = new Set<string>();
    const openings = sheets.balances.length ? await postedOpenings(ctx.apartmentId) : new Map();
    for (const input of sheets.balances) {
      push<BalanceRow>('balances', input, parseBalanceRow(input, asOfDate), (b) => {
        if (!knownUnit(b.unitKey)) return { field: 'number', message: 'Daire bulunamadı (Daireler sayfasında veya sistemde yok)' };
        if (seenBalances.has(b.key)) return { field: 'party', message: 'Aynı daire ve cari için dosyada birden fazla bakiye var' };
        seenBalances.add(b.key);
        const unitId = unitIdOf(b.unitKey);
        return unitId && openings.has(`${unitId}|${b.party}`) ? 'exists' : 'create';
      });
    }

    const count = (sheet: PreviewRow['sheet']) => {
      const r = rows.filter((x) => x.sheet === sheet);
      return { create: r.filter((x) => x.status === 'create').length, exists: r.filter((x) => x.status === 'exists').length, error: r.filter((x) => x.status === 'error').length };
    };
    const blockNames = new Set(blocks.map((b) => b.name.toLocaleLowerCase('tr-TR')));
    const blocksToCreate = [
      ...new Set(
        sheets.units
          .map((u) => (u.block ?? '').replace(/\s+/g, ' ').trim())
          .filter((b) => b && !blockNames.has(b.toLocaleLowerCase('tr-TR'))),
      ),
    ];
    const counts = { units: count('units'), people: count('people'), balances: count('balances') };
    const ok = globalErrors.length === 0 && rows.every((r) => r.status !== 'error');
    return { asOfDate, ok, counts, blocksToCreate, globalErrors, rows: rows.filter((r) => r.status === 'error').concat(rows.filter((r) => r.status !== 'error')) };
  }

  // -------------------------------------------------------------------------
  // Islem
  // -------------------------------------------------------------------------

  async function requireJob(ctx: ImportsContext, importId: string, open = true): Promise<ImportJob> {
    assertId(importId, 'importId');
    const job = await repo.getJob(ctx.apartmentId, importId);
    if (!job || job.apartmentId !== ctx.apartmentId) throw new ImportError('not_found', 'Aktarim bulunamadi');
    if (open && job.status !== 'in_progress') throw new ImportError('conflict', `Aktarim ${job.status === 'completed' ? 'tamamlanmis' : 'geri alinmis'}; yeni satir eklenemez`);
    return job;
  }

  async function start(ctx: ImportsContext, body: unknown): Promise<ImportJob> {
    const o = asObject(body);
    const importId = assertId(o.importId, 'importId');
    const asOfDate = parseAsOf(o.asOfDate);
    const fileName = optString(o, 'fileName', 200) ?? 'aktarim';
    const totalsRaw = asObject(o.totals ?? {}, 'totals');
    const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_ROWS ? v : 0);
    const existing = await repo.getJob(ctx.apartmentId, importId);
    if (existing) {
      if (existing.asOfDate !== asOfDate) throw new ImportError('conflict', 'Bu aktarim kimligi farkli bir devir tarihiyle baslatilmis');
      return existing;
    }
    const ts = stamp();
    const job: ImportJob = {
      ...importKeys.job(ctx.apartmentId, importId),
      entityType: 'IMPORT',
      importId,
      apartmentId: ctx.apartmentId,
      fileName,
      asOfDate,
      status: 'in_progress',
      totals: { units: n(totalsRaw.units), people: n(totalsRaw.people), balances: n(totalsRaw.balances) },
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    try {
      await repo.createJob(job);
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') return (await repo.getJob(ctx.apartmentId, importId)) as ImportJob;
      throw err;
    }
    return job;
  }

  type RowResult = { sheet: PreviewRow['sheet']; row: number; label: string; outcome: ImportOutcome; message?: string };

  /** Satiri bir kez isler: kayit varsa onceki sonucu doner. */
  async function once(
    ctx: ImportsContext,
    job: ImportJob,
    kind: ImportKind,
    itemKey: string,
    row: number | undefined,
    label: string,
    work: () => Promise<Partial<ImportItem> & { outcome: ImportOutcome }>,
  ): Promise<ImportItem> {
    const prior = await repo.getItem(ctx.apartmentId, job.importId, itemKey);
    if (prior) return prior;
    let result: Partial<ImportItem> & { outcome: ImportOutcome };
    try {
      result = await work();
    } catch (err) {
      const message = businessMessage(err);
      if (message === undefined) throw err; // gecici hata: parca tekrar denenir
      result = { outcome: 'error', message };
    }
    const item: ImportItem = {
      ...importKeys.item(ctx.apartmentId, job.importId, itemKey),
      entityType: 'IMPORT_ITEM',
      importId: job.importId,
      apartmentId: ctx.apartmentId,
      itemKey,
      kind,
      row,
      label,
      createdAt: stamp(),
      version: 1,
      ...result,
    };
    try {
      await repo.createItem(item);
    } catch (err) {
      if (err instanceof DataAccessError && err.code === 'conflict') {
        const raced = await repo.getItem(ctx.apartmentId, job.importId, itemKey);
        if (raced) return raced;
      }
      throw err;
    }
    return item;
  }

  async function processRows(ctx: ImportsContext, importId: string, body: unknown) {
    const job = await requireJob(ctx, importId);
    const sheets = readSheets(asObject(body), MAX_CHUNK);
    let snap = await snapshot(ctx.apartmentId);
    const results: RowResult[] = [];
    const record = (sheet: PreviewRow['sheet'], item: ImportItem) =>
      results.push({ sheet, row: item.row ?? 0, label: item.label, outcome: item.outcome, message: item.message });
    const financeCtx = { apartmentId: ctx.apartmentId, userId: ctx.userId };

    for (const input of sheets.units) {
      const parsed = parseUnitRow(input);
      const label = `${input.block ?? ''} · ${input.number ?? ''}`;
      if (!parsed.ok) {
        results.push({ sheet: 'units', row: input.row, label, outcome: 'error', message: parsed.errors.map((e) => e.message).join('; ') });
        continue;
      }
      const u = parsed.value;
      const item = await once(ctx, job, 'unit', u.key, u.row, `${u.block} · ${u.number}`, async () => {
        const existing = snap.unitsByKey.get(u.key.slice(5));
        if (existing) return { outcome: 'exists', unitId: existing.unitId };
        let block = snap.blocks.find((b) => b.name.toLocaleLowerCase('tr-TR') === u.block.toLocaleLowerCase('tr-TR'));
        if (!block) {
          try {
            block = await deps.core.createBlock(ctx.userId, ctx.apartmentId, { name: u.block });
          } catch (err) {
            if (!(err instanceof CoreError && err.code === 'conflict')) throw err;
          }
          snap = await snapshot(ctx.apartmentId);
          block ??= snap.blocks.find((b) => b.name.toLocaleLowerCase('tr-TR') === u.block.toLocaleLowerCase('tr-TR'));
          if (!block) throw new CoreError('not_found', 'Blok olusturulamadi');
        }
        const unit = await deps.core.createUnit(ctx.userId, ctx.apartmentId, {
          blockId: block.blockId,
          number: u.number,
          type: u.type,
          grossAreaM2: u.grossAreaM2,
          floor: u.floor,
          landShare: u.landShare,
        });
        snap.unitsByKey.set(u.key.slice(5), unit);
        return { outcome: 'created', unitId: unit.unitId };
      });
      record('units', item);
    }

    if (sheets.people.length || sheets.balances.length) snap = await snapshot(ctx.apartmentId);
    const activeUnit = (unitKey: string) => {
      const unit = snap.unitsByKey.get(unitKey);
      if (!unit || unit.status !== 'active') throw new CoreError('not_found', 'Daire bulunamadi (once Daireler sayfasi aktarilmali)');
      return unit;
    };

    for (const input of sheets.people) {
      const parsed = parsePersonRow(input, job.asOfDate);
      const label = `${input.block ?? ''} · ${input.number ?? ''} · ${input.email ?? ''}`;
      if (!parsed.ok) {
        results.push({ sheet: 'people', row: input.row, label, outcome: 'error', message: parsed.errors.map((e) => e.message).join('; ') });
        continue;
      }
      const p = parsed.value;
      const item = await once(ctx, job, 'person', p.key, p.row, `${p.block} · ${p.number} · ${p.fullName}`, async () => {
        const unit = activeUnit(p.unitKey);
        if (p.relation === 'tenant') {
          const current = await deps.memberships.list(
            { apartmentId: ctx.apartmentId, userId: ctx.userId },
            { unitId: unit.unitId, status: 'active' },
          );
          const sameUser = (await deps.people.list(ctx.apartmentId)).find((x) => x.email.toLowerCase() === p.email)?.userId;
          if (current.some((m) => m.relation === 'tenant' && m.userId !== sameUser)) {
            throw new CoreError('conflict', 'Bu dairede zaten aktif bir kiraci var');
          }
        }
        const r = await deps.residents.invite(
          ctx,
          {
            unitId: unit.unitId,
            fullName: p.fullName,
            email: p.email,
            relation: p.relation,
            residesInUnit: p.residesInUnit,
            startDate: p.startDate,
            ...(p.ownershipShare ? { ownershipShare: p.ownershipShare } : {}),
          },
          { sendInvitation: false },
        );
        return {
          outcome: 'created',
          unitId: unit.unitId,
          userId: r.person.userId,
          email: p.email,
          invitation: r.invitation === 'existing_user' ? 'existing_user' : 'pending',
        };
      });
      record('people', item);
    }

    const batchId = `import-${job.importId}`;
    let openings: Map<string, Set<string | undefined>> | undefined;
    for (const input of sheets.balances) {
      const parsed = parseBalanceRow(input, job.asOfDate);
      const label = `${input.block ?? ''} · ${input.number ?? ''}`;
      if (!parsed.ok) {
        results.push({ sheet: 'balances', row: input.row, label, outcome: 'error', message: parsed.errors.map((e) => e.message).join('; ') });
        continue;
      }
      const b = parsed.value;
      const item = await once(ctx, job, 'balance', b.key, b.row, `${b.block} · ${b.number} · ${b.party === 'owner' ? 'Malik' : 'Oturan'}`, async () => {
        const unit = activeUnit(b.unitKey);
        // Baska bir aktarimin (iptal edilmemis) devir bakiyesi varsa ikinci kez yazilmaz.
        // Bu aktarimin kendi kaydi ise (ornek: kayit yazildi, item yazilamadi) asagidaki
        // idempotent yazim ayni islemi doner.
        openings ??= await postedOpenings(ctx.apartmentId);
        const batches = openings.get(`${unit.unitId}|${b.party}`);
        if (batches && !batches.has(batchId)) return { outcome: 'exists', unitId: unit.unitId };
        const r = await deps.finance.postOpeningBalance(financeCtx, {
          idemId: `imp-${job.importId}-${unit.unitId}-${b.party === 'owner' ? 'o' : 't'}`.slice(0, 128),
          unitId: unit.unitId,
          party: b.party,
          amount: b.amount,
          date: job.asOfDate,
          dueDate: b.dueDate,
          description: b.description,
          batchId,
        });
        return { outcome: 'created', unitId: unit.unitId, transactionId: r.transaction.transactionId };
      });
      record('balances', item);
    }

    return { importId: job.importId, results };
  }

  /** Kasa / banka devir bakiyeleri (karar 3a). Bos alan atlanir. */
  async function setFunds(ctx: ImportsContext, importId: string, body: unknown) {
    const job = await requireJob(ctx, importId);
    const o = asObject(body);
    const out: { account: 'cash' | 'bank'; outcome: ImportOutcome; message?: string }[] = [];
    for (const account of ['cash', 'bank'] as const) {
      const raw = o[account];
      if (raw === undefined || raw === null || raw === '') continue;
      const amount = parseSignedKurus(typeof raw === 'string' ? raw : String(raw));
      if (amount === null || amount <= 0) throw new ValidationError(`${account === 'cash' ? 'Kasa' : 'Banka'} tutari gecersiz`, account);
      const item = await once(ctx, job, 'funds', `funds:${account}`, undefined, account === 'cash' ? 'Kasa' : 'Banka', async () => {
        const r = await deps.finance.postOpeningFunds(
          { apartmentId: ctx.apartmentId, userId: ctx.userId },
          { idemId: `imp-${job.importId}-${account}`, account, amount, date: job.asOfDate, batchId: `import-${job.importId}` },
        );
        return { outcome: 'created', transactionId: r.transaction.transactionId };
      });
      out.push({ account, outcome: item.outcome, message: item.message });
    }
    return { importId: job.importId, funds: out };
  }

  function countItems(items: ImportItem[]): ImportCounts {
    const c = emptyCounts();
    for (const i of items) c[i.kind][i.outcome]++;
    return c;
  }

  async function complete(ctx: ImportsContext, importId: string) {
    const job = await requireJob(ctx, importId, false);
    if (job.status !== 'in_progress') return publicJob(job);
    const items = await repo.listItems(ctx.apartmentId, importId);
    const ts = stamp();
    const next: ImportJob = { ...job, status: 'completed', counts: countItems(items), completedAt: ts, updatedAt: ts, updatedBy: ctx.userId, version: job.version + 1 };
    await repo.updateJob(next, job.version);
    return publicJob(next);
  }

  // -------------------------------------------------------------------------
  // Okuma
  // -------------------------------------------------------------------------

  function publicJob(job: ImportJob) {
    const { PK: _pk, SK: _sk, ...rest } = job;
    return rest;
  }

  async function list(ctx: ImportsContext) {
    const jobs = await repo.listJobs(ctx.apartmentId);
    return jobs
      .filter((j) => j.apartmentId === ctx.apartmentId && j.entityType === 'IMPORT')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicJob);
  }

  async function get(ctx: ImportsContext, importId: string) {
    const job = await requireJob(ctx, importId, false);
    const items = await repo.listItems(ctx.apartmentId, importId);
    const pendingInvitations = items.filter((i) => i.kind === 'person' && i.invitation === 'pending' && !i.rolledBack).length;
    return {
      ...publicJob(job),
      counts: job.counts ?? countItems(items),
      pendingInvitations,
      errors: items
        .filter((i) => i.outcome === 'error')
        .map((i) => ({ kind: i.kind, row: i.row, label: i.label, message: i.message }))
        .sort((a, b) => (a.row ?? 0) - (b.row ?? 0)),
    };
  }

  // -------------------------------------------------------------------------
  // Davetler (karar 1a)
  // -------------------------------------------------------------------------

  async function sendInvitations(ctx: ImportsContext, importId: string) {
    const job = await requireJob(ctx, importId, false);
    if (job.status === 'rolled_back') throw new ImportError('conflict', 'Geri alinmis aktarimin davetleri gonderilemez');
    const items = await repo.listItems(ctx.apartmentId, importId);
    const pending = items.filter((i) => i.kind === 'person' && i.invitation === 'pending' && i.email && !i.rolledBack);
    let sent = 0;
    for (const item of pending.slice(0, INVITE_BATCH)) {
      const result = await deps.residents.resendInvitation(item.email as string);
      await repo.updateItem({ ...item, invitation: result, version: item.version + 1 }, item.version);
      if (result === 'sent') sent++;
    }
    return { sent, remaining: Math.max(pending.length - INVITE_BATCH, 0) };
  }

  // -------------------------------------------------------------------------
  // Geri alma
  // -------------------------------------------------------------------------

  async function rollback(ctx: ImportsContext, importId: string, body: unknown) {
    const job = await requireJob(ctx, importId, false);
    const reason = optString(asObject(body ?? {}), 'reason', 200) ?? `Toplu aktarim geri alindi (${job.fileName})`;
    const items = (await repo.listItems(ctx.apartmentId, importId)).filter((i) => i.outcome === 'created' && !i.rolledBack);
    // Sira: once defter (ters kayit), sonra uyelikler, en son daireler (hareketi kalmadiysa).
    const order: ImportKind[] = ['balance', 'funds', 'person', 'unit'];
    const todo = items.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, ROLLBACK_BATCH);
    const financeCtx = { apartmentId: ctx.apartmentId, userId: ctx.userId };
    const report = { ...(job.rollbackReport ?? { reversed: 0, membershipsEnded: 0, unitsDeactivated: 0, unitsKept: 0 }) };
    let ledger: Awaited<ReturnType<FinanceRepository['listTransactions']>>['items'] | undefined;

    for (const item of todo) {
      if ((item.kind === 'balance' || item.kind === 'funds') && item.transactionId) {
        try {
          await deps.finance.reverseTransaction(financeCtx, item.transactionId, { reason: reason.slice(0, 300) });
        } catch (err) {
          // Zaten ters kayitla iptal edilmisse sorun degil.
          if (!(err instanceof FinanceError && err.code === 'conflict')) throw err;
        }
        report.reversed++;
      } else if (item.kind === 'person' && item.userId && item.unitId) {
        try {
          await deps.memberships.deactivate({ apartmentId: ctx.apartmentId, userId: ctx.userId }, item.userId, item.unitId);
        } catch (err) {
          if (!(err instanceof CoreError && err.code === 'not_found')) throw err;
        }
        report.membershipsEnded++;
      } else if (item.kind === 'unit' && item.unitId) {
        ledger ??= (await deps.financeRepo.listTransactions(ctx.apartmentId)).items;
        const cancelled = cancelledTransactions(ledger);
        const hasActivity = ledger.some((tx) => !cancelled.has(tx.transactionId) && tx.lines.some((l) => l.unitId === item.unitId));
        const otherMembers = (await deps.memberships.list({ apartmentId: ctx.apartmentId, userId: ctx.userId }, { unitId: item.unitId, status: 'active' })).length > 0;
        if (hasActivity || otherMembers) {
          report.unitsKept++;
        } else {
          await deps.core.deactivateUnit(ctx.userId, ctx.apartmentId, item.unitId);
          report.unitsDeactivated++;
        }
      }
      await repo.updateItem({ ...item, rolledBack: true, version: item.version + 1 }, item.version);
    }

    const remaining = items.length - todo.length;
    const fresh = (await repo.getJob(ctx.apartmentId, importId)) as ImportJob;
    const ts = stamp();
    const next: ImportJob = {
      ...fresh,
      status: remaining === 0 ? 'rolled_back' : fresh.status,
      rollbackReport: report,
      ...(remaining === 0 ? { rolledBackAt: ts } : {}),
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: fresh.version + 1,
    };
    await repo.updateJob(next, fresh.version);
    return { remaining, report, status: next.status };
  }

  return { preview, start, processRows, setFunds, complete, list, get, sendInvitations, rollback };
}

export type ImportsService = ReturnType<typeof createImportsService>;
