/**
 * Finans 2.2 - avans mahsubu (API): ayni kisi / muvafakatli ucuncu kisi, kismi ve hedefli mahsup,
 * idempotency, geri alma, ters kayit korumalari, sakin talebi + yonetici onay/ret.
 */
import { describe, expect, it } from 'vitest';
import type { AuthClaims } from '../src/auth/claims.js';
import { checkSettlements } from '../src/modules/finance/audit.js';
import { APT, MAIN, OWNER, TL, cariWorld, manager, observer } from './fakes/cariWorld.js';

type W = ReturnType<typeof cariWorld>;
const ownerResident: AuthClaims = { userId: 'own-1', role: 'resident', apartmentId: APT };

/** Oturan malik: sakin carisinde 600 TL avans, malik carisinde Eylul + Ekim 500'er TL borc. */
async function sameOwner(w: W) {
  w.member('own-1', { relation: 'owner', residesInUnit: true });
  await w.charge('o-sep', 500, '2026-09-01', '2026-09-10', 'owner');
  await w.charge('o-oct', 500, '2026-10-01', '2026-10-10', 'owner');
  await w.pay('p-adv', 600, '2026-09-15');
  w.setNow('2026-11-05');
}
const ownerDues = async (w: W) => (await w.txs()).filter((t) => t.kind === 'dues_charge').sort((a, b) => a.date.localeCompare(b.date));

const body = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: 'offset-0001',
  sourceAccountId: MAIN,
  targetAccountId: OWNER,
  amount: TL(600),
  reason: 'Avans aidata mahsup',
  ...over,
});

describe('avans mahsubu - ayni kisi', () => {
  it('onizleme yazmaz; mahsup tek atomik yazim (offset islemi + kayit + denetim)', async () => {
    const w = cariWorld();
    await sameOwner(w);
    const before = (await w.txs()).length;
    const pv = await w.call('POST', '/api/finance/offsets/preview', manager, { sourceAccountId: MAIN, targetAccountId: OWNER });
    expect(pv.status).toBe(200);
    expect(pv.json).toMatchObject({ sourceAdvance: TL(600), targetOpenDebt: TL(1000), maxAmount: TL(600), samePerson: true, consentRequired: false });
    expect(pv.json.targetOpenItems).toHaveLength(2);
    expect((await w.txs()).length).toBe(before);

    const r = await w.call('POST', '/api/finance/offsets', manager, body());
    expect(r.status).toBe(201);
    expect(r.json.offset).toMatchObject({ sourceAccountId: MAIN, targetAccountId: OWNER, amount: TL(600), samePerson: true, status: 'completed', date: '2026-11-05' });
    expect(r.json.offset).not.toHaveProperty('consent');
    expect(r.json.offset).not.toHaveProperty('PK');
    const batch = w.fake.batches.at(-1)!;
    expect(batch.transactions.map((t) => t.kind)).toEqual(['offset']);
    expect(batch.audit).toMatchObject({ action: 'finance.offset', details: { samePerson: true, thirdPartyConsent: false } });
    expect((await w.acc(MAIN))!.balance).toBe(0);
    expect((await w.acc(OWNER))!.balance).toBe(TL(400));
    // FIFO: Eylul kapandi, Ekim'de 400 kaldi.
    const after = await w.call('POST', '/api/finance/offsets/preview', manager, { sourceAccountId: MAIN, targetAccountId: OWNER });
    expect(after.json).toMatchObject({ sourceAdvance: 0, targetOpenDebt: TL(400), maxAmount: 0 });
    expect(after.json.targetOpenItems.map((i: any) => i.remaining)).toEqual([TL(400)]);
    expect(checkSettlements({ transactions: await w.txs() })).toEqual([]);

    const list = await w.call('GET', `/api/finance/offsets?accountId=${OWNER}`, observer);
    expect(list.json.items.map((o: any) => o.offsetId)).toEqual([r.json.offset.offsetId]);
  });

  it('tutar avansi veya hedef borcu asamaz; ayni cari ve gecersiz govde reddedilir', async () => {
    const w = cariWorld();
    await sameOwner(w);
    expect((await w.call('POST', '/api/finance/offsets', manager, body({ amount: TL(700) }))).status).toBe(422);
    expect((await w.call('POST', '/api/finance/offsets', manager, body({ idempotencyKey: 'offset-0002', targetAccountId: MAIN }))).status).toBe(400);
    expect((await w.call('POST', '/api/finance/offsets', manager, body({ idempotencyKey: 'offset-0003', reason: 'x' }))).status).toBe(400);
    expect((await w.call('POST', '/api/finance/offsets', observer, body())).status).toBe(403);
    // Ters yon: malik carisinde avans yok.
    const rev = await w.call('POST', '/api/finance/offsets', manager, body({ idempotencyKey: 'offset-0004', sourceAccountId: OWNER, targetAccountId: MAIN, amount: TL(100) }));
    expect(rev.status).toBe(422);
  });

  it('kismi ve hedefli mahsup: secilen kalem kapanir, FIFO diger kalemi korur', async () => {
    const w = cariWorld();
    await sameOwner(w);
    const [, oct] = await ownerDues(w);
    const r = await w.call('POST', '/api/finance/offsets', manager, body({ amount: TL(300), settles: [{ chargeId: oct!.transactionId, amount: TL(300) }] }));
    expect(r.status).toBe(201);
    const pv = await w.call('POST', '/api/finance/offsets/preview', manager, { sourceAccountId: MAIN, targetAccountId: OWNER });
    expect(pv.json.sourceAdvance).toBe(TL(300));
    expect(pv.json.targetOpenItems.map((i: any) => [i.dueDate, i.remaining])).toEqual([
      ['2026-09-10', TL(500)],
      ['2026-10-10', TL(200)],
    ]);
    // settles toplami tutara esit olmali; acik olmayan kalem reddedilir.
    expect((await w.call('POST', '/api/finance/offsets', manager, body({ idempotencyKey: 'offset-0005', amount: TL(100), settles: [{ chargeId: oct!.transactionId, amount: TL(50) }] }))).status).toBe(400);
    expect((await w.call('POST', '/api/finance/offsets', manager, body({ idempotencyKey: 'offset-0006', amount: TL(100), settles: [{ chargeId: 'yok', amount: TL(100) }] }))).status).toBe(400);
    // Hedefli kapanan kalemin islemi ters cevrilemez (once mahsup geri alinmali).
    const blocked = await w.call('POST', `/api/finance/transactions/${oct!.transactionId}/reversal`, manager, { reason: 'Hatali tahakkuk' });
    expect(blocked.status).toBe(422);
    expect(blocked.json.message).toMatch(/mahsub/);
  });

  it('idempotent: ayni anahtar ayni sonuc, farkli govde 409', async () => {
    const w = cariWorld();
    await sameOwner(w);
    const a = await w.call('POST', '/api/finance/offsets', manager, body({ amount: TL(200) }));
    const b = await w.call('POST', '/api/finance/offsets', manager, body({ amount: TL(200) }));
    expect(b.status).toBe(200);
    expect(b.json).toMatchObject({ replayed: true, offset: { offsetId: a.json.offset.offsetId } });
    expect((await w.call('POST', '/api/finance/offsets', manager, body({ amount: TL(300) }))).status).toBe(409);
    expect((await w.txs()).filter((t) => t.kind === 'offset')).toHaveLength(1);
  });

  it('geri alma: ters kayit + kayit reversed; genel ters kayit ucu reddeder; ikinci geri alma 409', async () => {
    const w = cariWorld();
    await sameOwner(w);
    const o = (await w.call('POST', '/api/finance/offsets', manager, body())).json.offset;
    const direct = await w.call('POST', `/api/finance/transactions/${o.transactionId}/reversal`, manager, { reason: 'Hatali mahsup' });
    expect(direct.status).toBe(422);
    const r = await w.call('POST', `/api/finance/offsets/${o.offsetId}/reverse`, manager, { reason: 'Hatali mahsup' });
    expect(r.status).toBe(200);
    expect(r.json.offset).toMatchObject({ status: 'reversed', reversal: { reason: 'Hatali mahsup' } });
    expect(w.fake.batches.at(-1)!.audit).toMatchObject({ action: 'finance.offset_reverse' });
    expect((await w.acc(MAIN))!.balance).toBe(-TL(600));
    expect((await w.acc(OWNER))!.balance).toBe(TL(1000));
    expect((await w.call('POST', `/api/finance/offsets/${o.offsetId}/reverse`, manager, { reason: 'Tekrar deneme' })).status).toBe(409);
    expect((await w.call('GET', `/api/finance/offsets/${o.offsetId}`, observer)).json.status).toBe('reversed');
  });
});

describe('avans mahsubu - farkli kisiler (muvafakat)', () => {
  async function thirdParty(w: W) {
    w.member('tenant-a', { relation: 'tenant', residesInUnit: true });
    w.member('owner-o', { relation: 'owner', residesInUnit: false });
    await w.charge('o-sep', 1000, '2026-09-01', '2026-09-10', 'owner');
    await w.pay('p-adv', 400, '2026-09-15');
    w.setNow('2026-11-05');
  }

  it('muvafakat beyani olmadan reddedilir; beyan + aciklama ile yazilir ve denetimde isaretlenir', async () => {
    const w = cariWorld();
    await thirdParty(w);
    const pv = await w.call('POST', '/api/finance/offsets/preview', manager, { sourceAccountId: MAIN, targetAccountId: OWNER });
    expect(pv.json).toMatchObject({ samePerson: false, consentRequired: true, maxAmount: TL(400) });
    const no = await w.call('POST', '/api/finance/offsets', manager, body({ amount: TL(400) }));
    expect(no.status).toBe(422);
    expect(no.json.message).toMatch(/muvafakat/);
    const bad = await w.call('POST', '/api/finance/offsets', manager, body({ idempotencyKey: 'offset-0010', amount: TL(400), consent: { thirdParty: true, note: 'ok' } }));
    expect(bad.status).toBe(400);
    const ok = await w.call('POST', '/api/finance/offsets', manager, body({ idempotencyKey: 'offset-0011', amount: TL(400), consent: { thirdParty: true, note: 'Kiracı yazılı muvafakat verdi' } }));
    expect(ok.status).toBe(201);
    expect(ok.json.offset).toMatchObject({ samePerson: false, consent: { thirdParty: true, note: 'Kiracı yazılı muvafakat verdi' } });
    expect(w.fake.batches.at(-1)!.audit).toMatchObject({ details: { thirdPartyConsent: true, consentNote: 'Kiracı yazılı muvafakat verdi' } });
    expect((await w.acc(OWNER))!.balance).toBe(TL(600));
  });
});

describe('avans mahsubu - sakin talebi', () => {
  it('sakin kendi carileri arasinda talep acar; yonetici onaylar (mahsup + talep atomik)', async () => {
    const w = cariWorld();
    await sameOwner(w);
    const opts = await w.call('GET', '/api/portal/offset-options', ownerResident);
    expect(opts.status).toBe(200);
    expect(opts.json.sources).toEqual([expect.objectContaining({ accountId: MAIN, advance: TL(600) })]);
    expect(opts.json.targets).toEqual([expect.objectContaining({ accountId: OWNER, openDebt: TL(1000) })]);

    const req = await w.call('POST', '/api/portal/offset-requests', ownerResident, {
      idempotencyKey: 'req-000001',
      sourceAccountId: MAIN,
      targetAccountId: OWNER,
      amount: TL(200),
      note: 'Avansım aidata sayılsın',
    });
    expect(req.status).toBe(201);
    expect(req.json.request).toMatchObject({ status: 'pending', userId: 'own-1', unitId: 'u1', amount: TL(200) });
    const again = await w.call('POST', '/api/portal/offset-requests', ownerResident, {
      idempotencyKey: 'req-000001',
      sourceAccountId: MAIN,
      targetAccountId: OWNER,
      amount: TL(200),
      note: 'Avansım aidata sayılsın',
    });
    expect(again.status).toBe(200);
    expect((await w.txs()).filter((t) => t.kind === 'offset')).toHaveLength(0);

    const pending = await w.call('GET', '/api/finance/offset-requests?status=pending', observer);
    expect(pending.json.items.map((r: any) => r.requestId)).toEqual([req.json.request.requestId]);
    expect((await w.call('POST', `/api/finance/offset-requests/${req.json.request.requestId}/approve`, observer, {})).status).toBe(403);

    const ap = await w.call('POST', `/api/finance/offset-requests/${req.json.request.requestId}/approve`, manager, {});
    expect(ap.status).toBe(201);
    expect(ap.json.offset).toMatchObject({ requestId: req.json.request.requestId, amount: TL(200), samePerson: true });
    expect(ap.json.request).toMatchObject({ status: 'approved', decision: { offsetId: ap.json.offset.offsetId, amount: TL(200) } });
    expect((await w.acc(OWNER))!.balance).toBe(TL(800));
    expect((await w.call('POST', `/api/finance/offset-requests/${req.json.request.requestId}/approve`, manager, {})).status).toBe(409);

    const mine = await w.call('GET', '/api/portal/offset-requests', ownerResident);
    expect(mine.json.items).toEqual([expect.objectContaining({ status: 'approved' })]);
    expect(mine.json.items[0]).not.toHaveProperty('PK');
  });

  it('yonetici reddeder; sakinin olmayan cari secilemez; tutar siniri', async () => {
    const w = cariWorld();
    await sameOwner(w);
    const req = await w.call('POST', '/api/portal/offset-requests', ownerResident, { idempotencyKey: 'req-000002', sourceAccountId: MAIN, targetAccountId: OWNER, amount: TL(100) });
    const rj = await w.call('POST', `/api/finance/offset-requests/${req.json.request.requestId}/reject`, manager, { reason: 'Malik ile görüşülecek' });
    expect(rj.status).toBe(200);
    expect(rj.json.request).toMatchObject({ status: 'rejected', decision: { reason: 'Malik ile görüşülecek' } });
    expect((await w.call('POST', `/api/finance/offset-requests/${req.json.request.requestId}/approve`, manager, {})).status).toBe(409);

    const foreign = await w.call('POST', '/api/portal/offset-requests', ownerResident, { idempotencyKey: 'req-000003', sourceAccountId: 'recv-u9-occupant', targetAccountId: OWNER, amount: TL(100) });
    expect(foreign.status).toBe(400);
    const tooMuch = await w.call('POST', '/api/portal/offset-requests', ownerResident, { idempotencyKey: 'req-000004', sourceAccountId: MAIN, targetAccountId: OWNER, amount: TL(601) });
    expect(tooMuch.status).toBe(422);
    // Yonetici rolu portal ucunu kullanamaz.
    expect((await w.call('GET', '/api/portal/offset-requests', manager)).status).toBe(403);
  });
});
