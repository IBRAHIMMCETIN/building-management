/**
 * Finans 2.2 sonrasi - tedarikci avans mahsubu: avans (kasa/banka -> tedarikci avans alacagi), acik
 * avanslar, faturalara tam / kismi / hedefli mahsup (tarihli, denetimli), ters kayitla geri alma,
 * FIFO dokumunde uygulanan avans, tedarikci ekstresi, idempotency, es zamanli mahsup (surum), kiraci
 * izolasyonu ve defter dengesi / degismezligi.
 */
import { describe, expect, it } from 'vitest';
import type { AuthClaims } from '../src/auth/claims.js';
import { type SupplierAdvance, type SupplierAdvanceOffset, buildSupplierStatement, supplierAdvanceAccountId } from '../src/modules/finance/supplierAdvances.js';
import { checkSupplierAdvances } from '../src/modules/finance/audit.js';
import { buildAnnualStatement } from '../src/modules/finance/ledgerReports.js';
import { payableSummary } from '../src/modules/finance/payables.js';
import { toLedgerEntries } from '../src/modules/finance/repository.js';
import type { Transaction } from '../src/modules/finance/types.js';
import { TL, cariWorld, manager, observer } from './fakes/cariWorld.js';

type W = ReturnType<typeof cariWorld>;
const SUP = 'pay-asansor';
const ADV = supplierAdvanceAccountId(SUP);
const foreignManager: AuthClaims = { userId: 'mgr-x', role: 'apartment_manager', apartmentId: 'apt-2' };

/** Kasada 20.000 TL; tedarikci hesabi; 05.09 avans 5.000 TL; 01.10 ve 15.10 vadeli faturalar (3.000 + 4.000). */
async function world() {
  const w = cariWorld();
  await w.pay('p-fund', 20000, '2026-09-01');
  expect((await w.call('POST', '/api/finance/accounts', manager, { accountId: SUP, type: 'payable', name: 'Asansör Bakım Ltd.' })).status).toBe(201);
  w.setNow('2026-09-05');
  const adv = await w.call('POST', '/api/finance/supplier-advances', manager, { idempotencyKey: 'adv-0001', payableAccountId: SUP, fundsAccountId: 'cash', amount: TL(5000), reference: 'DEKONT-1', description: 'Revizyon avansı' });
  expect(adv.status).toBe(201);
  w.setNow('2026-11-01');
  const invoice = async (key: string, amount: number, date: string, no: string) =>
    (await w.call('POST', '/api/finance/expenses', manager, { idempotencyKey: key, expenseAccountId: 'exp-elevator', creditAccountId: SUP, amount: TL(amount), date, description: `Asansör bakım faturası ${no}`, invoiceNumber: no })).json.transaction as Transaction;
  const a = await invoice('inv-a001', 3000, '2026-10-01', 'A-1');
  const b = await invoice('inv-b001', 4000, '2026-10-15', 'B-1');
  return { w, advance: adv.json.advance as { advanceId: string; transactionId: string }, a, b };
}

function snapshot(txs: Transaction[]) {
  return new Map(txs.map((t) => [t.transactionId, JSON.stringify(t)]));
}
async function assertLedger(w: W, before?: Map<string, string>) {
  const txs = await w.txs();
  for (const [id, json] of before ?? []) expect(JSON.stringify(txs.find((t) => t.transactionId === id))).toBe(json);
  for (const t of txs) {
    const d = t.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0);
    const c = t.lines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amount, 0);
    expect(d, t.transactionId).toBe(c);
    expect(t.totalAmount).toBe(d);
  }
  expect(w.fake.trialBalance()).toBe(0);
  // Hesap bakiyeleri = defter satirlarinin isaretli toplami.
  for (const a of [...w.fake.accounts.values()]) {
    const sum = txs.flatMap((t) => t.lines).filter((l) => l.accountId === a.accountId).reduce((s, l) => s + (l.side === 'debit' ? l.amount : -l.amount), 0);
    expect(a.balance, a.accountId).toBe(sum);
  }
}

const offsetBody = (over: Record<string, unknown> = {}) => ({ idempotencyKey: 'ofs-0001', amount: TL(2000), reason: 'Avans faturaya mahsup', ...over });

describe('avans verme', () => {
  it('kasadan avans: tedarikci avans hesabi borc / kasa alacak, kayit + denetim; borc hesabina yazilmaz', async () => {
    const { w, advance } = await world();
    expect((await w.acc('cash'))!.balance).toBe(TL(15000));
    const advAcc = (await w.acc(ADV))!;
    expect(advAcc).toMatchObject({ type: 'receivable', supplierAdvanceOf: SUP, balance: TL(5000), name: 'Asansör Bakım Ltd. - Verilen avans' });
    const tx = (await w.txs()).find((t) => t.transactionId === advance.transactionId)!;
    expect(tx).toMatchObject({ kind: 'supplier_advance', date: '2026-09-05', supplierAdvance: { advanceId: advance.advanceId, payableAccountId: SUP } });
    expect(tx.lines).toEqual([
      { accountId: ADV, side: 'debit', amount: TL(5000) },
      { accountId: 'cash', side: 'credit', amount: TL(5000) },
    ]);
    const audit = w.fake.batches.find((b) => b.audit?.action === 'finance.supplier_advance')!.audit!;
    expect(audit.details).toMatchObject({ payableAccountId: SUP, amount: TL(5000), reference: 'DEKONT-1' });
    // Tedarikci borcu yalnizca faturalar; avans ayri acik kalem.
    const list = await w.call('GET', '/api/finance/payables', observer);
    expect(list.json.items.find((i: any) => i.accountId === SUP)).toMatchObject({ openBalance: TL(7000), advanceOpen: TL(5000), billed: TL(7000), paid: 0, advanceApplied: 0 });
    expect(list.json.totalAdvanceOpen).toBe(TL(5000));
    // Ozet: avans sakin alacaklarina sayilmaz.
    const sum = await w.call('GET', '/api/finance/summary', observer);
    expect(sum.json).toMatchObject({ supplierAdvances: TL(5000), receivables: 0 });
    const open = await w.call('GET', `/api/finance/supplier-advances?accountId=${SUP}&status=open`, observer);
    expect(open.json).toMatchObject({ totalOpen: TL(5000), items: [{ advanceId: advance.advanceId, amount: TL(5000), applied: 0, open: TL(5000), status: 'open', offsets: [] }] });
    await assertLedger(w);
  });

  it('dogrulama: bakiye yetersiz, gelecek tarih, tedarikci olmayan hesap, yetki; idempotent', async () => {
    const { w } = await world();
    const body = { idempotencyKey: 'adv-0002', payableAccountId: SUP, fundsAccountId: 'cash', amount: TL(16000) };
    expect((await w.call('POST', '/api/finance/supplier-advances', manager, body)).json.error).toBe('insufficient_funds');
    expect((await w.call('POST', '/api/finance/supplier-advances', manager, { ...body, idempotencyKey: 'adv-0003', amount: TL(100), date: '2026-12-01' })).status).toBe(400);
    expect((await w.call('POST', '/api/finance/supplier-advances', manager, { ...body, idempotencyKey: 'adv-0004', amount: TL(100), payableAccountId: 'exp-elevator' })).status).toBe(400);
    expect((await w.call('POST', '/api/finance/supplier-advances', manager, { ...body, idempotencyKey: 'adv-0005', amount: 0 })).status).toBe(400);
    expect((await w.call('POST', '/api/finance/supplier-advances', observer, { ...body, idempotencyKey: 'adv-0006', amount: TL(100) })).status).toBe(403);
    const ok = { ...body, idempotencyKey: 'adv-0007', amount: TL(100) };
    const a = await w.call('POST', '/api/finance/supplier-advances', manager, ok);
    const b = await w.call('POST', '/api/finance/supplier-advances', manager, ok);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.json).toMatchObject({ replayed: true, advance: { advanceId: a.json.advance.advanceId } });
    expect((await w.call('POST', '/api/finance/supplier-advances', manager, { ...ok, amount: TL(200) })).status).toBe(409);
    expect((await w.txs()).filter((t) => t.kind === 'supplier_advance')).toHaveLength(2);
  });
});

describe('avans mahsubu', () => {
  it('hedefli kismi mahsup + FIFO otomatik mahsup: tarihli islem, FIFO dokumunde uygulanan avans, degismezlik', async () => {
    const { w, advance, a, b } = await world();
    const before = snapshot(await w.txs());
    const pv = await w.call('GET', `/api/finance/supplier-advances/${advance.advanceId}/offset-preview`, manager);
    expect(pv.json).toMatchObject({ advanceOpen: TL(5000), openBalance: TL(7000), maxAmount: TL(5000) });
    expect(pv.json.openItems.map((i: any) => [i.transactionId, i.open])).toEqual([
      [a.transactionId, TL(3000)],
      [b.transactionId, TL(4000)],
    ]);

    // 1) Yalnizca B faturasina 2.000 TL, 20.10 tarihli.
    const r1 = await w.call('POST', `/api/finance/supplier-advances/${advance.advanceId}/offsets`, manager, offsetBody({ date: '2026-10-20', settles: [{ transactionId: b.transactionId, amount: TL(2000) }] }));
    expect(r1.status).toBe(201);
    expect(r1.json.offset).toMatchObject({ amount: TL(2000), date: '2026-10-20', status: 'completed', settles: [{ transactionId: b.transactionId, amount: TL(2000) }] });
    expect(r1.json.advance).toMatchObject({ applied: TL(2000), open: TL(3000), status: 'open' });
    const tx1 = (await w.txs()).find((t) => t.transactionId === r1.json.offset.transactionId)!;
    expect(tx1).toMatchObject({ kind: 'supplier_advance_offset', date: '2026-10-20', reason: 'Avans faturaya mahsup' });
    expect(tx1.lines).toEqual([
      { accountId: SUP, side: 'debit', amount: TL(2000) },
      { accountId: ADV, side: 'credit', amount: TL(2000) },
    ]);
    expect(w.fake.batches.at(-1)!.audit).toMatchObject({ action: 'finance.supplier_advance_offset', reason: 'Avans faturaya mahsup', details: { advanceOpenAfter: TL(3000) } });
    let list = (await w.call('GET', '/api/finance/payables', observer)).json.items.find((i: any) => i.accountId === SUP);
    expect(list).toMatchObject({ openBalance: TL(5000), advanceOpen: TL(3000), advanceApplied: TL(2000), paid: 0 });
    expect(list.openItems.map((i: any) => [i.transactionId, i.open, i.advanceApplied ?? 0])).toEqual([
      [a.transactionId, TL(3000), 0],
      [b.transactionId, TL(2000), TL(2000)],
    ]);

    // 2) Kalan avans FIFO ile (en eski fatura A).
    const r2 = await w.call('POST', `/api/finance/supplier-advances/${advance.advanceId}/offsets`, manager, offsetBody({ idempotencyKey: 'ofs-0002', amount: TL(3000) }));
    expect(r2.status).toBe(201);
    expect(r2.json.offset.settles).toEqual([{ transactionId: a.transactionId, amount: TL(3000) }]);
    expect(r2.json.advance).toMatchObject({ applied: TL(5000), open: 0, status: 'applied' });
    list = (await w.call('GET', '/api/finance/payables', observer)).json.items.find((i: any) => i.accountId === SUP);
    expect(list).toMatchObject({ openBalance: TL(2000), advanceOpen: 0, advanceApplied: TL(5000) });
    expect(list.openItems.map((i: any) => [i.transactionId, i.open])).toEqual([[b.transactionId, TL(2000)]]);
    expect((await w.acc(SUP))!.balance).toBe(-TL(2000));
    expect((await w.acc(ADV))!.balance).toBe(0);
    // Tamamen mahsup edilmis avans tekrar mahsup edilemez.
    expect((await w.call('POST', `/api/finance/supplier-advances/${advance.advanceId}/offsets`, manager, offsetBody({ idempotencyKey: 'ofs-0003', amount: TL(1) }))).status).toBe(409);
    await assertLedger(w, before);
  });

  it('dogrulama: tutar sinirlari, settles toplami / acik fatura, tarih (avans ve fatura oncesi), gelecek tarih, yetki', async () => {
    const { w, advance, a, b } = await world();
    const url = `/api/finance/supplier-advances/${advance.advanceId}/offsets`;
    expect((await w.call('POST', url, manager, offsetBody({ amount: TL(5001) }))).status).toBe(422);
    expect((await w.call('POST', url, manager, offsetBody({ idempotencyKey: 'ofs-v002', settles: [{ transactionId: b.transactionId, amount: TL(1000) }] }))).status).toBe(400);
    expect((await w.call('POST', url, manager, offsetBody({ idempotencyKey: 'ofs-v003', settles: [{ transactionId: 'yok-fatura', amount: TL(2000) }] }))).status).toBe(400);
    expect((await w.call('POST', url, manager, offsetBody({ idempotencyKey: 'ofs-v004', amount: TL(3500), settles: [{ transactionId: a.transactionId, amount: TL(3500) }] }))).status).toBe(400);
    expect((await w.call('POST', url, manager, offsetBody({ idempotencyKey: 'ofs-v005', date: '2026-09-01' }))).status).toBe(400);
    expect((await w.call('POST', url, manager, offsetBody({ idempotencyKey: 'ofs-v006', date: '2026-10-10', settles: [{ transactionId: b.transactionId, amount: TL(2000) }] }))).status).toBe(400);
    expect((await w.call('POST', url, manager, offsetBody({ idempotencyKey: 'ofs-v007', date: '2026-11-02' }))).status).toBe(400);
    expect((await w.call('POST', url, manager, offsetBody({ idempotencyKey: 'ofs-v008', reason: 'x' }))).status).toBe(400);
    expect((await w.call('POST', url, observer, offsetBody({ idempotencyKey: 'ofs-v009' }))).status).toBe(403);
    expect((await w.call('POST', '/api/finance/supplier-advances/yok/offsets', manager, offsetBody({ idempotencyKey: 'ofs-v010' }))).status).toBe(404);
    expect((await w.txs()).filter((t) => t.kind === 'supplier_advance_offset')).toHaveLength(0);
  });

  it('idempotent: ayni anahtar ayni mahsup, farkli govde 409', async () => {
    const { w, advance } = await world();
    const url = `/api/finance/supplier-advances/${advance.advanceId}/offsets`;
    const x = await w.call('POST', url, manager, offsetBody());
    const y = await w.call('POST', url, manager, offsetBody());
    expect(y.status).toBe(200);
    expect(y.json).toMatchObject({ replayed: true, offset: { offsetId: x.json.offset.offsetId } });
    expect((await w.call('POST', url, manager, offsetBody({ amount: TL(1500) }))).status).toBe(409);
    expect((await w.txs()).filter((t) => t.kind === 'supplier_advance_offset')).toHaveLength(1);
  });

  it('es zamanli iki mahsup ayni avansi asamaz (hesap / kayit surumu): biri yazilir, digeri 409', async () => {
    const { w, advance } = await world();
    const url = `/api/finance/supplier-advances/${advance.advanceId}/offsets`;
    const [x, y] = await Promise.all([
      w.call('POST', url, manager, offsetBody({ idempotencyKey: 'ofs-c001', amount: TL(4000) })),
      w.call('POST', url, manager, offsetBody({ idempotencyKey: 'ofs-c002', amount: TL(4000) })),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect((await w.acc(ADV))!.balance).toBe(TL(1000));
    await assertLedger(w);
  });

  it('geri alma: genel ters kayit ucu reddeder; mahsup ve avans kendi uclarindan ters kayitla geri alinir', async () => {
    const { w, advance, b } = await world();
    const o = (await w.call('POST', `/api/finance/supplier-advances/${advance.advanceId}/offsets`, manager, offsetBody({ settles: [{ transactionId: b.transactionId, amount: TL(2000) }] }))).json.offset;
    const before = snapshot(await w.txs());
    for (const id of [advance.transactionId, o.transactionId, b.transactionId]) {
      const r = await w.call('POST', `/api/finance/transactions/${id}/reversal`, manager, { reason: 'Hatalı kayıt' });
      expect(r.status, id).toBe(422);
    }
    // Mahsup edilmis avans iptal edilemez.
    expect((await w.call('POST', `/api/finance/supplier-advances/${advance.advanceId}/reverse`, manager, { reason: 'Yanlış tedarikçi' })).status).toBe(422);

    const rv = await w.call('POST', `/api/finance/supplier-advance-offsets/${o.offsetId}/reverse`, manager, { reason: 'Yanlış fatura seçildi' });
    expect(rv.status).toBe(200);
    expect(rv.json.offset).toMatchObject({ status: 'reversed', reversal: { reason: 'Yanlış fatura seçildi' } });
    expect(rv.json.advance).toMatchObject({ applied: 0, open: TL(5000), status: 'open' });
    const rev = (await w.txs()).find((t) => t.transactionId === rv.json.offset.reversal.transactionId)!;
    expect(rev).toMatchObject({ kind: 'reversal', reversalOf: o.transactionId });
    expect(w.fake.batches.at(-1)!.audit).toMatchObject({ action: 'finance.supplier_advance_offset_reverse' });
    expect((await w.call('POST', `/api/finance/supplier-advance-offsets/${o.offsetId}/reverse`, manager, { reason: 'Tekrar deneme' })).status).toBe(409);
    expect((await w.acc(SUP))!.balance).toBe(-TL(7000));
    // Mahsup geri alindiktan sonra fatura da iptal edilebilir.
    expect((await w.call('POST', `/api/finance/transactions/${b.transactionId}/reversal`, manager, { reason: 'Hatalı fatura' })).status).toBe(201);

    const ra = await w.call('POST', `/api/finance/supplier-advances/${advance.advanceId}/reverse`, manager, { reason: 'Avans iade edildi' });
    expect(ra.status).toBe(200);
    expect(ra.json.advance).toMatchObject({ status: 'reversed', open: 0 });
    expect((await w.acc('cash'))!.balance).toBe(TL(20000));
    expect((await w.acc(ADV))!.balance).toBe(0);
    expect((await w.call('POST', `/api/finance/supplier-advances/${advance.advanceId}/reverse`, manager, { reason: 'Tekrar deneme' })).status).toBe(409);
    expect((await w.call('POST', `/api/finance/supplier-advances/${advance.advanceId}/offsets`, manager, offsetBody({ idempotencyKey: 'ofs-after' }))).status).toBe(409);
    await assertLedger(w, before);
  });
});

describe('raporlar', () => {
  it('tedarikci ekstresi: fatura, avans, mahsup, ters kayit; kapanis bakiyeleri hesaplarla ayni; tarih araligi devri', async () => {
    const { w, advance, a, b } = await world();
    const o = (await w.call('POST', `/api/finance/supplier-advances/${advance.advanceId}/offsets`, manager, offsetBody({ date: '2026-10-20', settles: [{ transactionId: b.transactionId, amount: TL(2000) }] }))).json.offset;
    await w.call('POST', `/api/finance/supplier-advance-offsets/${o.offsetId}/reverse`, manager, { reason: 'Yanlış fatura seçildi' });
    await w.call('POST', `/api/finance/supplier-advances/${advance.advanceId}/offsets`, manager, offsetBody({ idempotencyKey: 'ofs-0002', amount: TL(3000) }));
    const st = await w.call('GET', `/api/finance/payables/${SUP}/statement`, observer);
    expect(st.status).toBe(200);
    expect(st.json.rows.map((r: any) => [r.date, r.category])).toEqual([
      ['2026-09-05', 'advance'],
      ['2026-10-01', 'invoice'],
      ['2026-10-15', 'invoice'],
      ['2026-10-20', 'advance_offset'],
      ['2026-11-01', 'reversal'],
      ['2026-11-01', 'advance_offset'],
    ]);
    // Toplamlar net: geri alinan 2.000 TL mahsup kendi kategorisinden duser.
    expect(st.json.totals).toEqual({ invoice: TL(7000), payment: 0, advanceGiven: TL(5000), advanceApplied: TL(3000) });
    expect(st.json.rows.find((r: any) => r.category === 'reversal')).toMatchObject({ reverses: 'advance_offset' });
    const t = st.json.totals;
    expect(st.json.opening.payableBalance + t.invoice - t.payment - t.advanceApplied).toBe(st.json.closing.payableBalance);
    expect(st.json.opening.advanceBalance + t.advanceGiven - t.advanceApplied).toBe(st.json.closing.advanceBalance);
    expect(st.json.closing).toEqual({ payableBalance: TL(4000), advanceBalance: TL(2000), net: TL(2000) });
    expect(st.json.closing.payableBalance).toBe(-(await w.acc(SUP))!.balance);
    expect(st.json.closing.advanceBalance).toBe((await w.acc(ADV))!.balance);
    expect(st.json.summary).toMatchObject({ billed: TL(7000), advanceApplied: TL(3000), openBalance: TL(4000), advanceOpen: TL(2000), net: TL(2000) });
    expect(st.json.openItems.map((i: any) => [i.transactionId, i.open])).toEqual([[b.transactionId, TL(4000)]]);
    expect(st.json.openAdvances).toEqual([expect.objectContaining({ advanceId: advance.advanceId, open: TL(2000) })]);
    void a;

    const ranged = await w.call('GET', `/api/finance/payables/${SUP}/statement?from=2026-10-01&to=2026-10-31`, observer);
    expect(ranged.json.opening).toEqual({ payableBalance: 0, advanceBalance: TL(5000), net: -TL(5000) });
    expect(ranged.json.rows).toHaveLength(3);
    expect(ranged.json.closing).toEqual({ payableBalance: TL(5000), advanceBalance: TL(3000), net: TL(2000) });
    expect((await w.call('GET', `/api/finance/payables/${SUP}/statement?from=2026-11-01&to=2026-10-01`, observer)).status).toBe(400);
    expect((await w.call('GET', '/api/finance/payables/cash/statement', observer)).status).toBe(400);
  });

  it('saf: hedefe yerlesmeyen mahsup kalani (iptal edilen fatura) FIFO havuzuna girer', () => {
    type L = { accountId: string; side: 'debit' | 'credit'; amount: number };
    const tx = (id: string, kind: Transaction['kind'], date: string, lines: L[], extra: Partial<Transaction> = {}): Transaction =>
      ({ PK: 'p', SK: 's', entityType: 'TRANSACTION', transactionId: id, siteId: 'apt-1', kind, date, description: id, lines, totalAmount: lines[0]!.amount, createdAt: `${date}T00:00:00Z`, createdBy: 'u', ...extra }) as unknown as Transaction;
    const txs = [
      tx('inv1', 'expense', '2026-10-01', [{ accountId: 'exp', side: 'debit', amount: 100 }, { accountId: SUP, side: 'credit', amount: 100 }]),
      tx('inv2', 'expense', '2026-10-02', [{ accountId: 'exp', side: 'debit', amount: 100 }, { accountId: SUP, side: 'credit', amount: 100 }]),
      tx('ofs', 'supplier_advance_offset', '2026-10-03', [{ accountId: SUP, side: 'debit', amount: 60 }, { accountId: ADV, side: 'credit', amount: 60 }], { supplierAdvance: { advanceId: 'a', payableAccountId: SUP, settles: [{ transactionId: 'inv2', amount: 60 as never }] } }),
      tx('rev2', 'reversal', '2026-10-04', [{ accountId: 'exp', side: 'credit', amount: 100 }, { accountId: SUP, side: 'debit', amount: 100 }], { reversalOf: 'inv2' }),
    ];
    const entries = txs.flatMap((t) => toLedgerEntries(t));
    const s = payableSummary(SUP, entries, new Map(txs.map((t) => [t.transactionId, t])));
    expect(s).toMatchObject({ billed: 100, paid: 0, advanceApplied: 60, openBalance: 40 });
    expect(s.openItems).toEqual([expect.objectContaining({ transactionId: 'inv1', open: 40 })]);
    const st = buildSupplierStatement(SUP, ADV, entries, new Map(txs.map((t) => [t.transactionId, t])));
    expect(st.closing).toEqual({ payableBalance: 40, advanceBalance: -60, net: 100 });
  });
});

describe('inceleme duzeltmeleri', () => {
  it('fatura ters kaydi tedarikci hesap surumune kosullu; es zamanli ters kayit + mahsup ikisi birden yazilamaz', async () => {
    const { w, b } = await world();
    const rev = await w.call('POST', `/api/finance/transactions/${b.transactionId}/reversal`, manager, { reason: 'Hatalı fatura' });
    expect(rev.status).toBe(201);
    expect(w.fake.posted.at(-1)!.expectedVersions).toEqual({ [SUP]: expect.any(Number) });

    const r2 = await world();
    const [x, y] = await Promise.all([
      r2.w.call('POST', `/api/finance/transactions/${r2.b.transactionId}/reversal`, manager, { reason: 'Hatalı fatura' }),
      r2.w.call('POST', `/api/finance/supplier-advances/${r2.advance.advanceId}/offsets`, manager, offsetBody({ settles: [{ transactionId: r2.b.transactionId, amount: TL(2000) }] })),
    ]);
    expect([x.status, y.status].filter((s) => s < 300).length).toBeLessThanOrEqual(1);
    const txs = await r2.w.txs();
    const reversed = txs.some((t) => t.kind === 'reversal' && t.reversalOf === r2.b.transactionId);
    const offsetLive = txs.some((t) => t.kind === 'supplier_advance_offset');
    expect(reversed && offsetLive).toBe(false);
    await assertLedger(r2.w);
  });

  it('kapali doneme tarihli avans ve mahsup reddedilir (409 period_closed)', async () => {
    const { w, advance } = await world();
    w.fake.docs.set(`APT#apt-1|FINLOCK`, { PK: 'APT#apt-1', SK: 'FINLOCK', entityType: 'FINANCE_LOCK', lockedThrough: '2026-10-31', version: 1 });
    const adv = await w.call('POST', '/api/finance/supplier-advances', manager, { idempotencyKey: 'adv-lock1', payableAccountId: SUP, fundsAccountId: 'cash', amount: TL(100), date: '2026-10-15' });
    expect(adv.status).toBe(409);
    expect(adv.json.error).toBe('period_closed');
    const ofs = await w.call('POST', `/api/finance/supplier-advances/${advance.advanceId}/offsets`, manager, offsetBody({ idempotencyKey: 'ofs-lock1', date: '2026-10-20' }));
    expect(ofs.status).toBe(409);
    expect(ofs.json.error).toBe('period_closed');
    // Acik doneme tarihli mahsup yazilir.
    expect((await w.call('POST', `/api/finance/supplier-advances/${advance.advanceId}/offsets`, manager, offsetBody({ idempotencyKey: 'ofs-lock2' }))).status).toBe(201);
  });

  it('avans hesabi kimligi ayrilmis: POST /accounts supadv- 400; baska hesapca tutulan kimlik avans actirmaz', async () => {
    const { w } = await world();
    expect((await w.call('POST', '/api/finance/accounts', manager, { accountId: 'supadv-x', type: 'payable', name: 'Sahte' })).status).toBe(400);
    expect((await w.call('POST', '/api/finance/accounts', manager, { accountId: 'pay-yeni', type: 'payable', name: 'Yeni Tedarikçi' })).status).toBe(201);
    // Eski veriyle cakisan kimlik (avans hesabi olmayan hesap): avans reddedilir, defter yazilmaz.
    const ts = '2026-01-01T00:00:00.000Z';
    await w.fake.repo.ensureAccounts([
      { PK: 'APT#apt-1', SK: `ACCT#${supplierAdvanceAccountId('pay-yeni')}`, entityType: 'ACCOUNT', accountId: supplierAdvanceAccountId('pay-yeni'), siteId: 'apt-1', type: 'receivable', name: 'Eski', status: 'active', balance: 0 as never, createdAt: ts, createdBy: 'x', updatedAt: ts, updatedBy: 'x', version: 1 },
    ]);
    const r = await w.call('POST', '/api/finance/supplier-advances', manager, { idempotencyKey: 'adv-clash', payableAccountId: 'pay-yeni', fundsAccountId: 'cash', amount: TL(100) });
    expect(r.status).toBe(409);
    expect((await w.txs()).filter((t) => t.kind === 'supplier_advance')).toHaveLength(1);
  });

  it('pasif tedarikcinin acik avansi listede kalir; toplam ozet kartiyla ayni', async () => {
    const { w } = await world();
    // Faturalar ters kayitla iptal (bakiyesi olan hesap pasife alinamaz): borc 0, avans acik.
    for (const t of (await w.txs()).filter((x) => x.kind === 'expense')) {
      expect((await w.call('POST', `/api/finance/transactions/${t.transactionId}/reversal`, manager, { reason: 'Hatalı fatura' })).status).toBe(201);
    }
    const acc = (await w.acc(SUP))!;
    expect((await w.call('PATCH', `/api/finance/accounts/${SUP}`, manager, { status: 'inactive', version: acc.version })).status).toBeLessThan(300);
    const list = (await w.call('GET', '/api/finance/payables', observer)).json;
    expect(list.items.find((i: any) => i.accountId === SUP)).toMatchObject({ status: 'inactive', openBalance: 0, advanceOpen: TL(5000) });
    expect(list.totalAdvanceOpen).toBe((await w.call('GET', '/api/finance/summary', observer)).json.supplierAdvances);
  });

  it('kesin hesap: tedarikci avansi sakin alacaklarina sayilmaz, ayri satir', async () => {
    const { w } = await world();
    const accounts = [...w.fake.accounts.values()];
    const txs = await w.txs();
    const byMonth = new Map<string, Map<string, { debit: number; credit: number }>>();
    for (const t of txs) {
      const m = t.date.slice(0, 7);
      const cur = byMonth.get(m) ?? new Map();
      for (const l of t.lines) {
        const mv = cur.get(l.accountId) ?? { debit: 0, credit: 0 };
        mv[l.side] += l.amount;
        cur.set(l.accountId, mv);
      }
      byMonth.set(m, cur);
    }
    const st = buildAnnualStatement({ accounts, months: ['2026-09', '2026-10', '2026-11'], opening: new Map(), byMonth, closedMonths: [] });
    // Sakin carisinde 20.000 TL avans (odeme), alacak yok; tedarikci avansi ayri.
    expect(st.receivables).toMatchObject({ closing: 0, advancesClosing: TL(20000) });
    expect(st.supplierAdvances).toEqual({ opening: 0, closing: TL(5000) });
  });

  it('gece denetimi: avans kaydi, mahsuplar ve avans hesabi defterle tutarli; bozulma bulgu uretir', async () => {
    const { w, advance, b } = await world();
    const o = (await w.call('POST', `/api/finance/supplier-advances/${advance.advanceId}/offsets`, manager, offsetBody({ settles: [{ transactionId: b.transactionId, amount: TL(2000) }] }))).json.offset;
    await w.call('POST', `/api/finance/supplier-advance-offsets/${o.offsetId}/reverse`, manager, { reason: 'Yanlış fatura seçildi' });
    await w.call('POST', `/api/finance/supplier-advances/${advance.advanceId}/offsets`, manager, offsetBody({ idempotencyKey: 'ofs-0002', amount: TL(1500) }));
    const docs = [...w.fake.docs.values()];
    const snap = (advances: SupplierAdvance[]) => ({
      transactions: txs,
      entries: txs.flatMap((t) => toLedgerEntries(t)),
      supplierAdvances: advances,
      supplierAdvanceOffsets: docs.filter((d) => d.entityType === 'SUPPLIER_ADVANCE_OFFSET') as unknown as SupplierAdvanceOffset[],
    });
    const txs = await w.txs();
    const advances = docs.filter((d) => d.entityType === 'SUPPLIER_ADVANCE') as unknown as SupplierAdvance[];
    expect(checkSupplierAdvances(snap(advances))).toEqual([]);
    const tampered = advances.map((a) => ({ ...a, applied: (a.applied + 100) as never }));
    expect(checkSupplierAdvances(snap(tampered)).map((f) => f.detail)).toEqual([`applied:${advance.advanceId}`, 'advance_balance']);
    // Ad alanlari: istemci anahtari `SADVO_C_`, ic geri alma `SADVO_R_`.
    expect(w.fake.batches.map((x) => x.idempotency.id).filter((id) => id.startsWith('SADVO_'))).toEqual([`SADVO_C_ofs-0001`, `SADVO_R_${o.offsetId}`, 'SADVO_C_ofs-0002']);
  });
});

describe('kiraci izolasyonu', () => {
  it('baska apartmanin yoneticisi avanslari goremez, mahsup / geri alma yapamaz', async () => {
    const { w, advance } = await world();
    expect((await w.call('GET', '/api/finance/supplier-advances', foreignManager)).json.items).toEqual([]);
    expect((await w.call('GET', `/api/finance/supplier-advances/${advance.advanceId}`, foreignManager)).status).toBe(404);
    expect((await w.call('POST', `/api/finance/supplier-advances/${advance.advanceId}/offsets`, foreignManager, offsetBody())).status).toBe(404);
    expect((await w.call('POST', `/api/finance/supplier-advances/${advance.advanceId}/reverse`, foreignManager, { reason: 'Baska site' })).status).toBe(404);
    expect((await w.call('GET', `/api/finance/payables/${SUP}/statement`, foreignManager)).status).toBe(404);
    expect((await w.call('GET', `/api/finance/supplier-advances/${advance.advanceId}`, observer)).status).toBe(200);
  });
});
