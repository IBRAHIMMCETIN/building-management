/**
 * Finans 2.2 sonrasi - sakin portalindan yapilandirma talebi: sinirlar (ayarlar), dogrulama,
 * cari basina tek acik talep, idempotency, yonetim onayi (oldugu gibi / degisiklikle) mevcut
 * yapilandirma servisinden plan olusturur (defter degismezlik + denge), ret / geri cekme, es zamanli
 * onay (surum), kiraci izolasyonu, KVKK gorunurlugu, bildirim olaylari ve alicilari.
 */
import { describe, expect, it } from 'vitest';
import type { AuthClaims } from '../src/auth/claims.js';
import type { ApartmentRole } from '../src/modules/apartment-roles/types.js';
import { checkSettlements } from '../src/modules/finance/audit.js';
import { restructureRecipients } from '../src/modules/finance/planRequestNotifications.js';
import { type PlanRequest, defaultFirstDueDate, maxAllowedInstallments } from '../src/modules/finance/planRequests.js';
import type { Transaction } from '../src/modules/finance/types.js';
import { categoryOfEvent, categoryOfTemplate } from '../src/modules/notifications/categories.js';
import type { Notification } from '../src/modules/notifications/notifier.js';
import { renderPush } from '../src/modules/notifications/push-templates.js';
import { renderEmail } from '../src/modules/notifications/templates.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { buildNotifications } from '../src/workers/notification-worker.js';
import { APT, MAIN, TL, cariWorld, manager, observer, resident } from './fakes/cariWorld.js';

type W = ReturnType<typeof cariWorld>;
const otherTenant: AuthClaims = { userId: 'tenant-b', role: 'resident', apartmentId: APT };
const foreignManager: AuthClaims = { userId: 'mgr-x', role: 'apartment_manager', apartmentId: 'apt-2' };
const foreignResident: AuthClaims = { userId: 'tenant-a', role: 'resident', apartmentId: 'apt-2' };

/** Kiraci: Agustos, Eylul, Ekim aidatlari (1.000'er TL) odenmemis; bugun 05.11.2026. */
async function overdueTenant(w: W) {
  w.member('tenant-a', { relation: 'tenant', residesInUnit: true });
  await w.charge('c-aug', 1000, '2026-08-01', '2026-08-10');
  await w.charge('c-sep', 1000, '2026-09-01', '2026-09-10');
  await w.charge('c-oct', 1000, '2026-10-01', '2026-10-10');
  w.setNow('2026-11-05');
}

const req = (over: Record<string, unknown> = {}) => ({ idempotencyKey: 'plan-req-0001', installments: 4, note: 'Maaşım gecikti', ...over });

/** Defter degismezligi: once yazilmis islemler aynen durur; her islem dengeli; mizan 0. */
function snapshot(txs: Transaction[]) {
  return new Map(txs.map((t) => [t.transactionId, JSON.stringify(t)]));
}
async function assertLedger(w: W, before: Map<string, string>) {
  const txs = await w.txs();
  for (const [id, json] of before) expect(JSON.stringify(txs.find((t) => t.transactionId === id))).toBe(json);
  for (const t of txs) {
    const d = t.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0);
    const c = t.lines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amount, 0);
    expect(d).toBe(c);
  }
  expect(w.fake.trialBalance()).toBe(0);
  expect(checkSettlements({ transactions: txs })).toEqual([]);
}

describe('saf yardimcilar', () => {
  it('taksit siniri: ayar, 60 ust siniri ve en dusuk taksit tutari', () => {
    expect(maxAllowedInstallments(TL(3000), { maxInstallments: 6, minInstallmentAmount: TL(500) })).toBe(6);
    expect(maxAllowedInstallments(TL(1200), { maxInstallments: 6, minInstallmentAmount: TL(500) })).toBe(2);
    expect(maxAllowedInstallments(TL(900), { maxInstallments: 6, minInstallmentAmount: TL(500) })).toBe(1);
    expect(maxAllowedInstallments(0, { maxInstallments: 6, minInstallmentAmount: TL(500) })).toBe(0);
    expect(maxAllowedInstallments(TL(1_000_000), { maxInstallments: 60, minInstallmentAmount: TL(1) })).toBe(60);
  });
  it('ilk taksit varsayilani: sonraki ayin son odeme gunu', () => {
    expect(defaultFirstDueDate('2026-11-05', 10)).toBe('2026-12-10');
    expect(defaultFirstDueDate('2026-12-30', 31)).toBe('2027-01-28');
  });
});

describe('sakin talebi', () => {
  it('secenekler: gecikmis borc + tazminat, sinir; talep yazimi defteri degistirmez, olay + denetim yazilir', async () => {
    const w = cariWorld();
    await overdueTenant(w);
    const before = snapshot(await w.txs());
    const opt = await w.call('GET', '/api/portal/plan-requests/options', resident);
    expect(opt.status).toBe(200);
    const acc = opt.json.accounts[0];
    expect(opt.json.settings).toMatchObject({ enabled: true, maxInstallments: 6, minInstallmentAmount: TL(500), includeLateFees: true });
    expect(acc).toMatchObject({ accountId: MAIN, liableParty: 'occupant', overdue: TL(3000), eligible: true, maxInstallments: 6 });
    expect(acc.accruedLateFee).toBeGreaterThan(0);
    expect(acc.total).toBe(acc.overdue + acc.accruedLateFee);

    const r = await w.call('POST', '/api/portal/plan-requests', resident, req());
    expect(r.status).toBe(201);
    expect(r.json.request).toMatchObject({ accountId: MAIN, installments: 4, status: 'pending', note: 'Maaşım gecikti' });
    expect(r.json.request.estimate).toMatchObject({ overdue: TL(3000), total: acc.total, installmentAmount: Math.floor(acc.total / 4) });
    // Sakin gorunumunde ic alanlar yok.
    expect(r.json.request).not.toHaveProperty('clientKey');
    expect(r.json.request).not.toHaveProperty('fingerprint');
    expect(r.json.request).not.toHaveProperty('PK');
    const batch = w.fake.batches.at(-1)!;
    expect(batch.transactions).toEqual([]);
    expect(batch.audit).toMatchObject({ action: 'finance.plan_request', target: { type: 'plan_request' } });
    expect(w.fake.events('RESTRUCTURE_REQUESTED').map((e) => e.payload)).toEqual([{ requestId: r.json.request.requestId }]);
    await assertLedger(w, before);
  });

  it('sinirlar ve dogrulama: taksit sayisi, borcsuz cari, gecersiz govde', async () => {
    const w = cariWorld();
    await overdueTenant(w);
    expect((await w.call('POST', '/api/portal/plan-requests', resident, req({ installments: 7 }))).status).toBe(400);
    expect((await w.call('POST', '/api/portal/plan-requests', resident, req({ idempotencyKey: 'plan-req-0002', installments: 1 }))).status).toBe(400);
    expect((await w.call('POST', '/api/portal/plan-requests', resident, req({ idempotencyKey: 'x', installments: 3 }))).status).toBe(400);
    expect((await w.call('POST', '/api/portal/plan-requests', resident, req({ idempotencyKey: 'plan-req-0003', installments: 3.5 }))).status).toBe(400);
    expect((await w.call('POST', '/api/portal/plan-requests', resident, req({ idempotencyKey: 'plan-req-0004', liableParty: 'owner' }))).status).toBe(400);
    // Vadesi gecmemis borc talebe konu olmaz.
    const fresh = cariWorld();
    fresh.member('tenant-a', { relation: 'tenant', residesInUnit: true });
    await fresh.charge('c-nov', 1000, '2026-09-01', '2026-09-10');
    fresh.setNow('2026-09-05');
    const opt = await fresh.call('GET', '/api/portal/plan-requests/options', resident);
    expect(opt.json.accounts[0]).toMatchObject({ eligible: false, reason: 'no_overdue', overdue: 0 });
    expect((await fresh.call('POST', '/api/portal/plan-requests', resident, req())).status).toBe(422);
    // Yonetici / denetci portal ucunu kullanamaz.
    expect((await w.call('POST', '/api/portal/plan-requests', manager, req())).status).toBe(403);
  });

  it('idempotent: ayni anahtar ayni talep, farkli govde 409; cari basina tek acik talep', async () => {
    const w = cariWorld();
    await overdueTenant(w);
    const a = await w.call('POST', '/api/portal/plan-requests', resident, req());
    const b = await w.call('POST', '/api/portal/plan-requests', resident, req());
    expect(b.status).toBe(200);
    expect(b.json).toMatchObject({ replayed: true, request: { requestId: a.json.request.requestId } });
    expect((await w.call('POST', '/api/portal/plan-requests', resident, req({ installments: 5 }))).status).toBe(409);
    const second = await w.call('POST', '/api/portal/plan-requests', resident, req({ idempotencyKey: 'plan-req-0009' }));
    expect(second.status).toBe(409);
    expect(second.json.message).toMatch(/bekleyen/);
    expect(w.fake.events('RESTRUCTURE_REQUESTED')).toHaveLength(1);
  });

  it('es zamanli iki talep: biri yazilir, digeri 409', async () => {
    const w = cariWorld();
    await overdueTenant(w);
    const [x, y] = await Promise.all([
      w.call('POST', '/api/portal/plan-requests', resident, req({ idempotencyKey: 'plan-req-a001' })),
      w.call('POST', '/api/portal/plan-requests', resident, req({ idempotencyKey: 'plan-req-b001' })),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect((await w.call('GET', '/api/finance/plan-requests', manager)).json.items).toHaveLength(1);
  });

  it('KVKK: ayni cariyi goren diger uye talebi gormez (yalnizca bekleyen talep var); denetci 403', async () => {
    const w = cariWorld();
    await overdueTenant(w);
    w.member('tenant-b', { relation: 'tenant', residesInUnit: true });
    await w.call('POST', '/api/portal/plan-requests', resident, req());
    const mine = await w.call('GET', '/api/portal/plan-requests', resident);
    expect(mine.json.items).toHaveLength(1);
    const theirs = await w.call('GET', '/api/portal/plan-requests', otherTenant);
    expect(theirs.json.items).toEqual([]);
    const opt = await w.call('GET', '/api/portal/plan-requests/options', otherTenant);
    expect(opt.json.accounts[0]).toMatchObject({ eligible: false, reason: 'pending_request', pendingRequest: 'other' });
    expect(opt.json.accounts[0]).not.toHaveProperty('pendingRequestId');
    expect(JSON.stringify(opt.json)).not.toContain('Maaşım');
    expect((await w.call('POST', '/api/portal/plan-requests', otherTenant, req({ idempotencyKey: 'plan-req-other' }))).status).toBe(409);
    // Baskasinin talebini geri cekemez (var olmayanla ayni yanit).
    const id = mine.json.items[0].requestId;
    expect((await w.call('POST', `/api/portal/plan-requests/${id}/withdraw`, otherTenant, {})).status).toBe(404);
    expect((await w.call('GET', '/api/finance/plan-requests', observer)).status).toBe(403);
    expect((await w.call('GET', `/api/finance/plan-requests/${id}`, observer)).status).toBe(403);
  });

  it('kiraci izolasyonu: baska apartmanin yoneticisi / sakini talebi goremez ve sonuclandiramaz', async () => {
    const w = cariWorld();
    await overdueTenant(w);
    const id = (await w.call('POST', '/api/portal/plan-requests', resident, req())).json.request.requestId;
    expect((await w.call('GET', '/api/finance/plan-requests', foreignManager)).json.items).toEqual([]);
    expect((await w.call('GET', `/api/finance/plan-requests/${id}`, foreignManager)).status).toBe(404);
    expect((await w.call('POST', `/api/finance/plan-requests/${id}/approve`, foreignManager, {})).status).toBe(404);
    expect((await w.call('POST', `/api/finance/plan-requests/${id}/reject`, foreignManager, { reason: 'Baska site' })).status).toBe(404);
    expect((await w.call('GET', '/api/portal/plan-requests/options', foreignResident)).status).toBe(403);
    expect((await w.call('GET', `/api/finance/plan-requests/${id}`, manager)).json.request.status).toBe('pending');
  });

  it('sakin talebini geri ceker: cari basligi serbest kalir, yeni talep acilabilir', async () => {
    const w = cariWorld();
    await overdueTenant(w);
    const id = (await w.call('POST', '/api/portal/plan-requests', resident, req())).json.request.requestId;
    const wd = await w.call('POST', `/api/portal/plan-requests/${id}/withdraw`, resident, {});
    expect(wd.status).toBe(200);
    expect(wd.json.request).toMatchObject({ status: 'withdrawn', decision: { mode: 'withdrawn' } });
    expect(wd.json.request.decision).not.toHaveProperty('by');
    expect((await w.call('POST', `/api/portal/plan-requests/${id}/withdraw`, resident, {})).status).toBe(409);
    expect((await w.call('POST', '/api/portal/plan-requests', resident, req({ idempotencyKey: 'plan-req-0010', installments: 3 }))).status).toBe(201);
  });
});

describe('yonetim karari', () => {
  async function pending(w: W, over: Record<string, unknown> = {}) {
    await overdueTenant(w);
    return (await w.call('POST', '/api/portal/plan-requests', resident, req(over))).json.request as { requestId: string };
  }

  it('oldugu gibi onay: mevcut yapilandirma servisiyle plan (tazminat dondurma + taksitler), talep approved, olay + denetim', async () => {
    const w = cariWorld();
    const { requestId } = await pending(w);
    const before = snapshot(await w.txs());
    const detail = await w.call('GET', `/api/finance/plan-requests/${requestId}`, manager);
    expect(detail.status).toBe(200);
    expect(detail.json.asIs).toMatchObject({ accountId: MAIN, installments: 4, firstDueDate: '2026-12-10', includeLateFees: true });
    expect(detail.json.asIs.chargeIds).toHaveLength(3);
    expect(detail.json.request).not.toHaveProperty('clientKey');

    const r = await w.call('POST', `/api/finance/plan-requests/${requestId}/approve`, manager, {});
    expect(r.status).toBe(201);
    expect(r.json.request).toMatchObject({ status: 'approved', decision: { mode: 'as_is', installments: 4, firstDueDate: '2026-12-10', by: 'mgr-1' } });
    expect(r.json.plan).toMatchObject({ accountId: MAIN, status: 'active', includeLateFees: true });
    expect(r.json.plan.installments).toHaveLength(4);
    expect(r.json.request.decision.planId).toBe(r.json.plan.planId);
    expect(r.json.request.decision.total).toBe(r.json.plan.total);
    // Ayni defter kayitlari (yeni defter mantigi yok): tazminat kesinlesmesi + restructure.
    const batch = w.fake.batches.at(-1)!;
    expect(batch.transactions.map((t) => t.kind)).toEqual(['late_fee', 'restructure']);
    expect(batch.audit).toMatchObject({ action: 'finance.plan_request_approve', target: { type: 'plan_request', id: requestId }, details: { mode: 'as_is', planId: r.json.plan.planId } });
    expect(w.fake.events('RESTRUCTURE_APPROVED').map((e) => e.payload)).toEqual([{ requestId }]);
    // Cari bakiyesi korunur (borc taksitlere tasindi + kesinlesen tazminat).
    expect((await w.acc(MAIN))!.balance).toBe(TL(3000) + r.json.plan.frozenLateFee);
    await assertLedger(w, before);

    // Ikinci onay / ret 409; aktif planli cariye yeni talep 409.
    expect((await w.call('POST', `/api/finance/plan-requests/${requestId}/approve`, manager, {})).status).toBe(409);
    expect((await w.call('POST', `/api/finance/plan-requests/${requestId}/reject`, manager, { reason: 'Gec kaldi' })).status).toBe(409);
    const again = await w.call('POST', '/api/portal/plan-requests', resident, req({ idempotencyKey: 'plan-req-0020' }));
    expect(again.status).toBe(409);
    expect(again.json.message).toMatch(/aktif bir taksit planı/);
    // Sakin karari gorur (yonetici kimligi yok).
    const mine = (await w.call('GET', '/api/portal/plan-requests', resident)).json.items[0];
    expect(mine).toMatchObject({ status: 'approved', decision: { mode: 'as_is', planId: r.json.plan.planId } });
    expect(mine.decision).not.toHaveProperty('by');
    expect((await w.call('GET', '/api/portal/my-plans', resident)).json.items).toHaveLength(1);
  });

  it('degisiklikle onay: taksit sayisi, ilk vade ve tazminatin plana alinmamasi', async () => {
    const w = cariWorld();
    const { requestId } = await pending(w);
    const r = await w.call('POST', `/api/finance/plan-requests/${requestId}/approve`, manager, { installments: 3, firstDueDate: '2026-11-20', includeLateFees: false, reason: 'Üç taksit uygun görüldü' });
    expect(r.status).toBe(201);
    expect(r.json.request.decision).toMatchObject({ mode: 'changed', installments: 3, firstDueDate: '2026-11-20', reason: 'Üç taksit uygun görüldü' });
    expect(r.json.plan).toMatchObject({ includeLateFees: false, total: TL(3000) });
    expect(r.json.plan.installments.map((i: any) => i.dueDate)).toEqual(['2026-11-20', '2026-12-20', '2027-01-20']);
    // Plan kurallari mevcut servisten: gecmis tarihli ilk vade reddedilir (talep bekler).
    const w2 = cariWorld();
    const p2 = await pending(w2);
    expect((await w2.call('POST', `/api/finance/plan-requests/${p2.requestId}/approve`, manager, { firstDueDate: '2026-10-01' })).status).toBe(400);
    expect((await w2.call('GET', `/api/finance/plan-requests/${p2.requestId}`, manager)).json.request.status).toBe('pending');
  });

  it('es zamanli iki onay (farkli degisiklik): biri plan olusturur, digeri 409; tek plan', async () => {
    const w = cariWorld();
    const { requestId } = await pending(w);
    const [a, b] = await Promise.all([
      w.call('POST', `/api/finance/plan-requests/${requestId}/approve`, manager, { installments: 3 }),
      w.call('POST', `/api/finance/plan-requests/${requestId}/approve`, manager, { installments: 5 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect((await w.call('GET', '/api/finance/plans', manager)).json.items).toHaveLength(1);
    expect((await w.txs()).filter((t) => t.kind === 'restructure')).toHaveLength(1);
    expect(w.fake.events('RESTRUCTURE_APPROVED')).toHaveLength(1);
  });

  it('es zamanli onay ve ret: yalnizca biri sonuclanir', async () => {
    const w = cariWorld();
    const { requestId } = await pending(w);
    const [a, b] = await Promise.all([
      w.call('POST', `/api/finance/plan-requests/${requestId}/approve`, manager, {}),
      w.call('POST', `/api/finance/plan-requests/${requestId}/reject`, manager, { reason: 'Belgeler eksik' }),
    ]);
    expect([a.status, b.status].filter((s) => s === 409)).toHaveLength(1);
    const status = (await w.call('GET', `/api/finance/plan-requests/${requestId}`, manager)).json.request.status;
    expect(['approved', 'rejected']).toContain(status);
    expect((await w.txs()).filter((t) => t.kind === 'restructure')).toHaveLength(status === 'approved' ? 1 : 0);
  });

  it('ret: gerekce zorunlu; olay; cari basligi serbest, yeni talep acilabilir; defter degismez', async () => {
    const w = cariWorld();
    const { requestId } = await pending(w);
    const before = snapshot(await w.txs());
    expect((await w.call('POST', `/api/finance/plan-requests/${requestId}/reject`, manager, { reason: 'x' })).status).toBe(400);
    const r = await w.call('POST', `/api/finance/plan-requests/${requestId}/reject`, manager, { reason: 'Önce bir ödeme yapılmalı' });
    expect(r.status).toBe(200);
    expect(r.json.request).toMatchObject({ status: 'rejected', decision: { mode: 'rejected', reason: 'Önce bir ödeme yapılmalı' } });
    expect(w.fake.batches.at(-1)!.audit).toMatchObject({ action: 'finance.plan_request_reject', reason: 'Önce bir ödeme yapılmalı' });
    expect(w.fake.events('RESTRUCTURE_REJECTED').map((e) => e.payload)).toEqual([{ requestId }]);
    await assertLedger(w, before);
    const list = await w.call('GET', '/api/finance/plan-requests?status=pending', manager);
    expect(list.json).toMatchObject({ items: [], pendingCount: 0 });
    expect((await w.call('GET', '/api/finance/plan-requests?status=yok', manager)).status).toBe(400);
    expect((await w.call('POST', '/api/portal/plan-requests', resident, req({ idempotencyKey: 'plan-req-0030', installments: 2 }))).status).toBe(201);
  });
});

describe('ayarlar', () => {
  it('varsayilan, surum kontrollu guncelleme, sinirlarin talebe yansimasi, yetki', async () => {
    const w = cariWorld();
    await overdueTenant(w);
    const g = await w.call('GET', '/api/finance/plan-requests/settings', manager);
    expect(g.json).toMatchObject({ version: 0, settings: { enabled: true, maxInstallments: 6 } });
    const u = await w.call('PUT', '/api/finance/plan-requests/settings', manager, { version: 0, maxInstallments: 3, minInstallmentAmount: TL(800), includeLateFees: false });
    expect(u.status).toBe(200);
    expect(u.json).toMatchObject({ version: 1, settings: { maxInstallments: 3, minInstallmentAmount: TL(800), includeLateFees: false } });
    expect(w.fake.batches.at(-1)!.audit).toMatchObject({ action: 'finance.plan_request_settings' });
    expect((await w.call('PUT', '/api/finance/plan-requests/settings', manager, { version: 0, maxInstallments: 4 })).status).toBe(409);
    expect((await w.call('PUT', '/api/finance/plan-requests/settings', manager, { version: 1, maxInstallments: 61 })).status).toBe(400);
    expect((await w.call('PUT', '/api/finance/plan-requests/settings', observer, { version: 1, maxInstallments: 4 })).status).toBe(403);
    const opt = await w.call('GET', '/api/portal/plan-requests/options', resident);
    // Tazminat dahil degil: toplam yalnizca gecikmis anapara; 3.000 / 800 = 3.
    expect(opt.json.accounts[0]).toMatchObject({ total: TL(3000), maxInstallments: 3 });
    expect((await w.call('POST', '/api/portal/plan-requests', resident, req({ installments: 4 }))).status).toBe(400);
    const ok = await w.call('POST', '/api/portal/plan-requests', resident, req({ idempotencyKey: 'plan-req-0040', installments: 3 }));
    expect(ok.json.request.estimate).toMatchObject({ total: TL(3000), installmentAmount: TL(1000) });
    // Yonetim talepleri kapatir: yeni talep acilamaz.
    await w.call('PUT', '/api/finance/plan-requests/settings', manager, { version: 1, enabled: false });
    const w2opt = await w.call('GET', '/api/portal/plan-requests/options', resident);
    expect(w2opt.json.settings.enabled).toBe(false);
  });
});

describe('bildirimler', () => {
  const day = '2026-11-05';
  const role = (userId: string, r: ApartmentRole['role'], extra: Partial<ApartmentRole> = {}) =>
    ({ userId, apartmentId: APT, role: r, status: 'active', startDate: '2026-01-01', ...extra }) as ApartmentRole;
  const roles = [role('mgr-1', 'apartment_manager'), role('firm-1', 'management_company'), role('staff-1', 'building_staff'), role('old-mgr', 'apartment_manager', { status: 'inactive' })];
  const members = [
    { userId: 'tenant-a', apartmentId: APT, unitId: 'u1', relation: 'tenant', residesInUnit: true, status: 'active', startDate: '2026-01-01' },
  ] as unknown as UnitMembership[];
  const base: PlanRequest = {
    PK: `APT#${APT}`,
    SK: 'PLANREQ#r1',
    entityType: 'PLAN_REQUEST',
    requestId: 'r1',
    apartmentId: APT,
    userId: 'tenant-a',
    unitId: 'u1',
    accountId: MAIN,
    liableParty: 'occupant',
    installments: 4,
    note: 'Özel not',
    estimate: { overdue: TL(3000), accruedLateFee: TL(100), total: TL(3100), installmentAmount: TL(775) },
    status: 'pending',
    clientKey: 'k',
    fingerprint: 'f',
    createdAt: '2026-11-05T09:00:00.000Z',
    createdBy: 'tenant-a',
    updatedAt: '2026-11-05T09:00:00.000Z',
    updatedBy: 'tenant-a',
    version: 1,
  };
  const ev = (type: 'RESTRUCTURE_REQUESTED' | 'RESTRUCTURE_APPROVED' | 'RESTRUCTURE_REJECTED', apartmentId = APT) => ({
    eventId: `${type}:r1`,
    type,
    apartmentId,
    actorId: 'x',
    occurredAt: '2026-11-05T09:00:00.000Z',
    payload: { requestId: 'r1' },
  });

  it('talep -> aktif yonetici + firma; onay / ret -> talebi acan sakin; bayat / baska apartman -> kimse', () => {
    const requested = restructureRecipients(ev('RESTRUCTURE_REQUESTED') as any, members, roles, day, base);
    expect(requested.map((r) => r.userId).sort()).toEqual(['firm-1', 'mgr-1']);
    expect(requested[0]).toMatchObject({ template: 'restructure_requested', data: { installments: 4, total: TL(3100), unitId: 'u1' } });
    expect(JSON.stringify(requested)).not.toContain('Özel not');
    // Sonuclanmis talep icin eski "talep" olayi gitmez.
    expect(restructureRecipients(ev('RESTRUCTURE_REQUESTED') as any, members, roles, day, { ...base, status: 'withdrawn' })).toEqual([]);

    const approved = { ...base, status: 'approved' as const, decision: { at: 'x', by: 'mgr-1', mode: 'changed' as const, reason: 'ok', planId: 'p1', installments: 3, firstDueDate: '2026-12-10', total: TL(3100) } };
    expect(restructureRecipients(ev('RESTRUCTURE_APPROVED') as any, members, roles, day, approved)).toEqual([
      { userId: 'tenant-a', template: 'restructure_approved', data: expect.objectContaining({ installments: 3, requestedInstallments: 4, firstDueDate: '2026-12-10', changed: 'true' }) },
    ]);
    const rejected = { ...base, status: 'rejected' as const, decision: { at: 'x', by: 'mgr-1', mode: 'rejected' as const, reason: 'Belge eksik' } };
    expect(restructureRecipients(ev('RESTRUCTURE_REJECTED') as any, members, roles, day, rejected)[0]).toMatchObject({ template: 'restructure_rejected', data: { reason: 'Belge eksik' } });
    // Ayrilan sakin, bayat durum, baska apartman, kayit yok.
    expect(restructureRecipients(ev('RESTRUCTURE_REJECTED') as any, [], roles, day, rejected)).toEqual([]);
    expect(restructureRecipients(ev('RESTRUCTURE_APPROVED') as any, members, roles, day, rejected)).toEqual([]);
    expect(restructureRecipients(ev('RESTRUCTURE_APPROVED', 'apt-2') as any, members, roles, day, approved)).toEqual([]);
    expect(restructureRecipients(ev('RESTRUCTURE_APPROVED') as any, members, roles, day, null)).toEqual([]);
    // Worker uzerinden ayni sonuc.
    expect(buildNotifications(ev('RESTRUCTURE_REQUESTED') as any, members, new Map(), day, roles, { planRequest: base }).map((n) => n.userId).sort()).toEqual(['firm-1', 'mgr-1']);
  });

  it('kategori finance; e-posta ve push sablonlari (push tutar / gerekce tasimaz)', () => {
    for (const t of ['RESTRUCTURE_REQUESTED', 'RESTRUCTURE_APPROVED', 'RESTRUCTURE_REJECTED']) expect(categoryOfEvent(t)).toBe('finance');
    for (const t of ['restructure_requested', 'restructure_approved', 'restructure_rejected']) expect(categoryOfTemplate(t)).toBe('finance');
    const ctx = { siteName: 'Güneş Sitesi', unitLabel: () => 'A Blok - 5', portalUrl: 'https://site.example/app' };
    const n = (template: Notification['template'], data: Notification['data']): Notification => ({ eventId: 'e', apartmentId: APT, userId: 'u', template, data });
    const reqMail = renderEmail(n('restructure_requested', { unitId: 'u1', liableParty: 'occupant', installments: 4, total: TL(3100), installmentAmount: TL(775) }), ctx)!;
    expect(reqMail.subject).toContain('Yeni yapılandırma talebi');
    expect(reqMail.text).toContain('3.100,00 TL');
    expect(reqMail.html).toContain('https://site.example/admin/finance?tab=plans');
    const rejMail = renderEmail(n('restructure_rejected', { unitId: 'u1', reason: '<b>Belge</b> eksik' }), ctx)!;
    expect(rejMail.text).toContain('Gerekçe: <b>Belge</b> eksik');
    expect(rejMail.html).not.toContain('<b>Belge</b>');
    const okMail = renderEmail(n('restructure_approved', { unitId: 'u1', installments: 3, requestedInstallments: 4, firstDueDate: '2026-12-10', total: TL(3100), changed: 'true' }), ctx)!;
    expect(okMail.text).toContain('değişiklikle onaylandı');
    expect(okMail.text).toContain('10.12.2026');
    const pushRej = renderPush(n('restructure_rejected', { unitId: 'u1', reason: 'Belge eksik' }))!;
    expect(pushRej).toMatchObject({ path: '/borclar', category: 'finance' });
    expect(pushRej.body).not.toContain('Belge');
    const pushReq = renderPush(n('restructure_requested', { installments: 4, total: TL(3100) }))!;
    expect(pushReq.body).not.toContain('3.100');
  });
});
