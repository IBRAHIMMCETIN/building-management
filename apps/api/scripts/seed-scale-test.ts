/**
 * Adim 2-4: sentetik buyuk site tohumlama (yuk testi icin).
 *
 * Diyarbakir hedef olcegi: 4-5 blok, 300-500 daire, cok aylik hareket. Tum yazimlar uygulamanin
 * kendi servisleriyle yapilir (ayni is kurallari: append-only defter, kurus, idempotency, atomik
 * yazim). Tekrar calistirilabilir: site/blok/daire/uyelik varsa atlanir; tahakkuk, tahsilat ve
 * gider deterministik idempotency anahtarlariyla yazildigi icin ikinci calisma kayit uretmez.
 *
 * GUVENLIK: yalnizca adi `-local` veya `-dev` ile biten tabloya yazar (prod tablosuna asla).
 * Baska tablo icin bilincli olarak `--allow-table <ad>` verilmelidir.
 *
 *   $env:DYNAMODB_TABLE_NAME = "building-management-local"
 *   npm run seed:scale-test -w @bm/api                                  # 5 blok x 80 = 400 daire, 12 ay
 *   npm run seed:scale-test -w @bm/api -- --units 500 --blocks 5 --months 18 --site scale-diyarbakir-500
 *   npm run seed:scale-test -w @bm/api -- --dry-run                     # yalnizca plan
 *
 * Uretilenler (varsayilanlar):
 *   - site `scale-diyarbakir-400` (aylik aidat plani: 400 x 750 TL, m2 dagitim, son odeme 10'u)
 *   - bloklar A..E, her blokta 20 kat x 4 daire (85-160 m2)
 *   - her daireye kat maliki uyeligi (`scale-owner-<blok><no>`); her 3 daireden birine kiraci
 *   - her ay: aylik aidat tahakkuku (tek toplu islem), dairelerin ~%75'inden tahsilat
 *     (nakit / havale), 6 kalem ortak gider (temizlik, elektrik, su, isinma, personel, asansor)
 * Yuk testi (`npm run load:test`) ayni site kimligini ve kullanici kimliklerini kullanir.
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { getDynamo } from '../src/config/dynamodb.js';
import { coreRepository } from '../src/modules/core/repository.js';
import { CoreError, createCoreService } from '../src/modules/core/service.js';
import { type Kurus, toKurus } from '../src/modules/core/types.js';
import { FinanceError, createFinanceService } from '../src/modules/finance/service.js';
import { membershipRepository } from '../src/modules/memberships/repository.js';
import { createMembershipService } from '../src/modules/memberships/service.js';

export type ScaleSeedOptions = {
  siteId: string;
  units: number;
  blocks: number;
  months: number;
  /** Son ay (YYYY-MM); varsayilan: bu aydan bir onceki ay. */
  lastMonth: string;
  dryRun: boolean;
};

export const ACTOR = 'seed-scale-test';
export const BLOCK_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;
const MONTHLY_DUES_PER_UNIT = 75_000; // 750,00 TL
const EXPENSE_ITEMS: readonly { accountId: string; amount: number; description: string }[] = [
  { accountId: 'exp-cleaning', amount: 4_500_000, description: 'Temizlik hizmeti' },
  { accountId: 'exp-electricity', amount: 3_200_000, description: 'Ortak alan elektrik' },
  { accountId: 'exp-water', amount: 1_800_000, description: 'Ortak alan su' },
  { accountId: 'exp-heating', amount: 9_500_000, description: 'Merkezi isinma dogalgaz' },
  { accountId: 'exp-staff', amount: 6_000_000, description: 'Personel maasi' },
  { accountId: 'exp-elevator', amount: 1_200_000, description: 'Asansor bakim' },
];

/** Deterministik sozde rastgele (ayni girdi -> ayni veri). */
export function seededRandom(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let s = h >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function monthsBack(last: string, count: number): string[] {
  const [y, m] = last.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** Blok basina daire dagilimi ve daire numaralari (ornek: 400 / 5 = 80 -> A1..A80). */
export function unitPlan(units: number, blocks: number): { block: string; number: string; floor: number; areaM2: number }[] {
  const r = seededRandom(`units-${units}-${blocks}`);
  const per = Math.ceil(units / blocks);
  const out: { block: string; number: string; floor: number; areaM2: number }[] = [];
  for (let b = 0; b < blocks && out.length < units; b++) {
    for (let n = 1; n <= per && out.length < units; n++) {
      out.push({ block: BLOCK_LETTERS[b] as string, number: String(n), floor: Math.floor((n - 1) / 4), areaM2: 85 + Math.round(r() * 75) });
    }
  }
  return out;
}

export const ownerIdOf = (block: string, number: string) => `scale-owner-${block}${number}`.toLowerCase();
export const tenantIdOf = (block: string, number: string) => `scale-tenant-${block}${number}`.toLowerCase();

const isConflict = (err: unknown) =>
  (err instanceof CoreError && err.code === 'conflict') || (err instanceof FinanceError && (err.code === 'conflict' || err.code === 'idempotency_conflict'));

export async function seedScaleTest(o: ScaleSeedOptions, log: Pick<Console, 'info'> = console) {
  const plan = unitPlan(o.units, o.blocks);
  const months = monthsBack(o.lastMonth, o.months);
  const stats = { blocks: 0, units: 0, memberships: 0, dues: 0, payments: 0, expenses: 0, skipped: 0 };
  log.info(`Plan: site ${o.siteId}, ${o.blocks} blok, ${plan.length} daire, ${months[0]}..${months.at(-1)} (${months.length} ay)`);
  if (o.dryRun) return { ...stats, months: months.length, plannedUnits: plan.length };

  const core = createCoreService({ newId: () => o.siteId });
  if (!(await coreRepository.getSite(o.siteId))) {
    await core.createSite(ACTOR, 'tenant-scale-test', {
      name: `Ölçek Testi Sitesi (${plan.length} daire)`,
      type: 'site',
      address: { line1: 'Sentetik Mah. Yük Testi Cad. No:1', district: 'Kayapınar', city: 'Diyarbakır' },
      settings: {
        dueDayOfMonth: 10,
        monthlyDuesPlan: { enabled: true, totalAmount: MONTHLY_DUES_PER_UNIT * plan.length, distributionKey: 'area', liableParty: 'occupant' },
      },
    });
    log.info(`Site olusturuldu: ${o.siteId}`);
  }
  const ids = createCoreService();

  // Bloklar
  const blocks = new Map((await ids.listBlocks(o.siteId, 'all')).map((b) => [b.name, b.blockId]));
  for (const letter of BLOCK_LETTERS.slice(0, o.blocks)) {
    const name = `${letter} Blok`;
    if (blocks.has(name)) continue;
    const b = await ids.createBlock(ACTOR, o.siteId, { name, floorCount: 20 });
    blocks.set(name, b.blockId);
    stats.blocks++;
  }

  // Daireler
  const existing = await ids.listUnits(o.siteId, { status: 'all' });
  const unitId = new Map(existing.items.map((u) => [`${u.blockId}|${u.number}`, u.unitId]));
  for (const p of plan) {
    const blockId = blocks.get(`${p.block} Blok`) as string;
    if (unitId.has(`${blockId}|${p.number}`)) continue;
    const u = await ids.createUnit(ACTOR, o.siteId, { blockId, number: p.number, type: 'flat', grossAreaM2: p.areaM2, floor: p.floor });
    unitId.set(`${blockId}|${p.number}`, u.unitId);
    stats.units++;
    if (stats.units % 50 === 0) log.info(`  ${stats.units} daire`);
  }

  // Uyelikler (malik herkes; her 3 daireden birinde kiraci)
  const memberships = createMembershipService();
  const startDate = `${months[0]}-01`;
  const ctx = { apartmentId: o.siteId, userId: ACTOR };
  const current = await membershipRepository.list(o.siteId).catch(() => []);
  const has = new Set(current.map((m) => `${m.userId}|${m.unitId}`));
  let idx = 0;
  for (const p of plan) {
    const uid = unitId.get(`${blocks.get(`${p.block} Blok`)}|${p.number}`) as string;
    const want: { userId: string; relation: 'owner' | 'tenant' }[] = [{ userId: ownerIdOf(p.block, p.number), relation: 'owner' }];
    if (idx++ % 3 === 0) want.push({ userId: tenantIdOf(p.block, p.number), relation: 'tenant' });
    for (const w of want) {
      if (has.has(`${w.userId}|${uid}`)) continue;
      try {
        await memberships.create(ctx, { userId: w.userId, unitId: uid, relation: w.relation, ...(w.relation === 'owner' ? { residesInUnit: idx % 3 !== 1 } : {}), startDate });
        stats.memberships++;
      } catch (err) {
        if (!isConflict(err)) throw err;
        stats.skipped++;
      }
    }
  }

  // Aylik hareketler
  const finance = createFinanceService({ memberships: membershipRepository });
  const site = await coreRepository.getSite(o.siteId);
  const duesPlan = site?.settings.monthlyDuesPlan;
  const units = [...unitId.entries()].map(([k, id]) => ({ key: k, unitId: id }));
  for (const month of months) {
    const r = seededRandom(`${o.siteId}-${month}`);
    const dues = await finance.autoChargeDues(o.siteId, { period: month, plan: duesPlan, dueDayOfMonth: site?.settings.dueDayOfMonth ?? 10 });
    if (dues.status === 'charged' && !dues.replayed) stats.dues++;
    for (const u of units) {
      if (r() > 0.75) continue;
      const day = String(1 + Math.floor(r() * 27)).padStart(2, '0');
      try {
        const res = await finance.recordPayment(ctx, {
          idempotencyKey: `scale-pay-${u.unitId}-${month}`,
          unitId: u.unitId,
          liableParty: 'occupant',
          amount: toKurus(50_000 + Math.floor(r() * 50_000)) as Kurus,
          method: r() < 0.7 ? 'bank_transfer' : 'cash',
          paidAt: `${month}-${day}`,
        });
        if (!res.replayed) stats.payments++;
      } catch (err) {
        if (!isConflict(err)) throw err;
        stats.skipped++;
      }
    }
    for (const e of EXPENSE_ITEMS) {
      try {
        const res = await finance.recordExpense(ctx, {
          idempotencyKey: `scale-exp-${month}-${e.accountId}`,
          expenseAccountId: e.accountId,
          creditAccountId: 'bank',
          amount: toKurus(Math.round(e.amount * (0.85 + r() * 0.3))),
          date: `${month}-15`,
          description: `${e.description} (${month})`,
        });
        if (!(res as { replayed?: boolean }).replayed) stats.expenses++;
      } catch (err) {
        if (!isConflict(err)) throw err;
        stats.skipped++;
      }
    }
    log.info(`  ${month}: tahakkuk + tahsilat + gider tamam (${JSON.stringify(stats)})`);
  }
  return { ...stats, months: months.length, plannedUnits: plan.length };
}

export function assertSafeTable(table: string | undefined, allow?: string): string {
  if (!table) throw new Error('DYNAMODB_TABLE_NAME tanimli degil');
  if (allow && allow === table) return table;
  if (!/-(local|dev)$/.test(table)) throw new Error(`Guvenlik: yalnizca "-local" / "-dev" tablolarina tohum yazilir (verilen: ${table}). Bilincli istisna: --allow-table ${table}`);
  return table;
}

function previousMonth(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      units: { type: 'string', default: '400' },
      blocks: { type: 'string', default: '5' },
      months: { type: 'string', default: '12' },
      'last-month': { type: 'string' },
      site: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'allow-table': { type: 'string' },
    },
  });
  const units = Number(values.units);
  const blocks = Number(values.blocks);
  const months = Number(values.months);
  if (!Number.isInteger(units) || units < 1 || units > 2000) throw new Error('--units 1-2000 olmali');
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > BLOCK_LETTERS.length) throw new Error(`--blocks 1-${BLOCK_LETTERS.length} olmali`);
  if (!Number.isInteger(months) || months < 1 || months > 60) throw new Error('--months 1-60 olmali');
  const lastMonth = values['last-month'] ?? previousMonth();
  if (!/^\d{4}-\d{2}$/.test(lastMonth)) throw new Error('--last-month YYYY-MM olmali');
  assertSafeTable(process.env.DYNAMODB_TABLE_NAME, values['allow-table']);
  if (!values['dry-run']) getDynamo();
  const started = Date.now();
  const r = await seedScaleTest({ siteId: values.site ?? `scale-diyarbakir-${units}`, units, blocks, months, lastMonth, dryRun: values['dry-run'] });
  console.info(`Bitti (${Math.round((Date.now() - started) / 1000)} sn): ${JSON.stringify(r)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
