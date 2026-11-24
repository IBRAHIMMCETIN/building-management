import { describe, expect, it } from 'vitest';
import { APT, manager, meterWorld, observer, resident, staff } from './fakes/meterWorld.js';

const actions = (w: ReturnType<typeof meterWorld>) => w.audits.map((a) => a.action);

describe('sayac sicili - yetki ve dogrulama', () => {
  it('yalnizca yonetici tanimlar; denetci okur; gorevli ve sakin sicili yonetemez', async () => {
    const w = meterWorld();
    const body = { unitId: 'u1', kind: 'heat_allocator', label: 'Salon', openingIndex: 100, installedAt: '2026-01-01' };
    expect((await w.call('POST', '/api/metering/meters', staff, body)).status).toBe(403);
    expect((await w.call('POST', '/api/metering/meters', observer, body)).status).toBe(403);
    const r = await w.call('POST', '/api/metering/meters', manager, { ...body, serialNo: 'PO-1', factor: { num: 3, den: 2 } });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ unitId: 'u1', status: 'active', scale: 0, factor: { num: 3, den: 2 }, version: 1 });
    expect(r.json.PK).toBeUndefined();
    expect((await w.call('GET', '/api/metering/meters', observer)).json.items).toHaveLength(1);
    expect((await w.call('GET', '/api/metering/meters', resident)).status).toBe(403);
    expect((await w.call('GET', '/api/metering/meters', null)).status).toBe(401);
    const detail = await w.call('GET', `/api/metering/meters/${r.json.meterId}`, observer);
    expect(detail.json.events.map((e: { type: string }) => e.type)).toEqual(['install']);
    expect(actions(w)).toEqual(['meters.meter_create']);
    expect(w.audits[0]).toMatchObject({ apartmentId: APT, target: { type: 'meter', id: r.json.meterId } });
  });

  it('girdi hatalari: bilinmeyen daire, olcek, ileri tarih, mukerrer seri no', async () => {
    const w = meterWorld();
    const base = { unitId: 'u1', kind: 'heat_allocator', label: 'Salon', openingIndex: 0, installedAt: '2026-01-01' };
    expect((await w.call('POST', '/api/metering/meters', manager, { ...base, unitId: 'yok' })).status).toBe(404);
    expect((await w.call('POST', '/api/metering/meters', manager, { ...base, scale: 7 })).status).toBe(400);
    expect((await w.call('POST', '/api/metering/meters', manager, { ...base, installedAt: '2027-01-01' })).status).toBe(400);
    expect((await w.call('POST', '/api/metering/meters', manager, { ...base, factor: { num: 0, den: 1 } })).status).toBe(400);
    await w.createMeter({ unitId: 'u1', serialNo: 'po-9' });
    const dup = await w.call('POST', '/api/metering/meters', manager, { ...base, unitId: 'u2', serialNo: 'PO-9' });
    expect(dup.status).toBe(409);
  });

  it('guncelleme: surum kontrolu; onayli okumasi olan sayacin katsayi / olcegi degismez', async () => {
    const w = meterWorld();
    const m = await w.createMeter({ unitId: 'u1' });
    expect((await w.call('PATCH', `/api/metering/meters/${m.meterId}`, manager, { version: 9, label: 'X' })).status).toBe(409);
    const ok = await w.call('PATCH', `/api/metering/meters/${m.meterId}`, manager, { version: 1, label: 'Mutfak', factor: { num: 2, den: 1 } });
    expect(ok.json).toMatchObject({ label: 'Mutfak', factor: { num: 2, den: 1 }, version: 2 });
    w.patchMeter(m.meterId, { lastReading: { index: 150, date: '2026-10-31', periodId: 'p0' } });
    const blocked = await w.call('PATCH', `/api/metering/meters/${m.meterId}`, manager, { version: 2, factor: { num: 3, den: 1 } });
    expect(blocked.status).toBe(422);
    expect((await w.call('PATCH', `/api/metering/meters/${m.meterId}`, manager, { version: 2, scale: 2 })).status).toBe(422);
    expect((await w.call('PATCH', `/api/metering/meters/${m.meterId}`, manager, { version: 2, maxIndex: 99999 })).json.maxIndex).toBe(99999);
  });

  it('emeklilik: kapanis endeksi geri gidemez; basarili emeklilik olay ve denetim yazar', async () => {
    const w = meterWorld();
    const m = await w.createMeter({ unitId: 'u1', openingIndex: 100 });
    const back = await w.call('POST', `/api/metering/meters/${m.meterId}/retire`, manager, { retiredAt: '2026-11-20', closingIndex: 90, reason: 'Söküldü' });
    expect(back.status).toBe(422);
    const ok = await w.call('POST', `/api/metering/meters/${m.meterId}/retire`, manager, { retiredAt: '2026-11-20', closingIndex: 130, reason: 'Söküldü' });
    expect(ok.json).toMatchObject({ status: 'retired', retiredAt: '2026-11-20', closingIndex: 130 });
    expect(actions(w)).toContain('meters.meter_retire');
  });
});

describe('sayac degisimi / sifirlama (kural 3)', () => {
  const swapBody = (meterId: string, over: Record<string, unknown> = {}) => ({
    idempotencyKey: 'swap-key-0001',
    meterId,
    kind: 'replacement',
    swapDate: '2026-11-15',
    oldClosingIndex: 160,
    newOpeningIndex: 0,
    newSerialNo: 'PO-NEW',
    reason: 'Arızalı payölçer değişti',
    ...over,
  });

  it('onizleme kapanisa kadarki tuketimi gosterir; geri giden kapanis engellenir', async () => {
    const w = meterWorld();
    const m = await w.createMeter({ unitId: 'u1', openingIndex: 100, serialNo: 'PO-OLD' });
    const pv = await w.call('POST', '/api/metering/swaps/preview', manager, swapBody(m.meterId));
    expect(pv.status).toBe(200);
    expect(pv.json).toMatchObject({ startIndex: 100, closingDelta: 60, newMeter: { openingIndex: 0, installedAt: '2026-11-15', serialNo: 'PO-NEW' } });
    const back = await w.call('POST', '/api/metering/swaps', manager, swapBody(m.meterId, { oldClosingIndex: 99 }));
    expect(back.status).toBe(422);
    expect(back.json.message).toContain('küçük olamaz');
  });

  it('onayli okumadan once / ayni gune degisim reddedilir', async () => {
    const w = meterWorld();
    const m = await w.createMeter({ unitId: 'u1' });
    w.patchMeter(m.meterId, { lastReading: { index: 140, date: '2026-11-15', periodId: 'p0' } });
    expect((await w.call('POST', '/api/metering/swaps', manager, swapBody(m.meterId))).status).toBe(422);
  });

  it('atomik degisim: eski sayac replaced, yeni sayac acilisla; tekrar ayni anahtarla ayni sonuc', async () => {
    const w = meterWorld();
    const m = await w.createMeter({ unitId: 'u1', openingIndex: 100, serialNo: 'PO-OLD' });
    const r = await w.call('POST', '/api/metering/swaps', manager, swapBody(m.meterId));
    expect(r.status).toBe(201);
    const { swap, oldMeter, newMeter } = r.json;
    expect(swap).toMatchObject({ kind: 'replacement', oldMeterId: m.meterId, oldClosingIndex: 160, newOpeningIndex: 0, status: 'active' });
    expect(oldMeter).toMatchObject({ status: 'replaced', successorMeterId: newMeter.meterId, closingIndex: 160, retiredAt: '2026-11-15' });
    expect(newMeter).toMatchObject({ status: 'active', unitId: 'u1', predecessorMeterId: m.meterId, openingIndex: 0, installedAt: '2026-11-15', serialNo: 'PO-NEW' });
    expect(actions(w)).toEqual(['meters.meter_create', 'meters.swap_create']);

    const again = await w.call('POST', '/api/metering/swaps', manager, swapBody(m.meterId));
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ replayed: true, swap: { swapId: swap.swapId } });
    const other = await w.call('POST', '/api/metering/swaps', manager, swapBody(m.meterId, { oldClosingIndex: 170 }));
    expect(other.status).toBe(409);
    const twice = await w.call('POST', '/api/metering/swaps', manager, swapBody(m.meterId, { idempotencyKey: 'swap-key-0002' }));
    expect(twice.status).toBe(422);
  });

  it('sifirlama: ayni seri no korunur; degisimde ayni seri no reddedilir', async () => {
    const w = meterWorld();
    const m = await w.createMeter({ unitId: 'u1', serialNo: 'PO-1' });
    const wrong = await w.call('POST', '/api/metering/swaps', manager, swapBody(m.meterId, { newSerialNo: 'po-1' }));
    expect(wrong.status).toBe(400);
    const { newSerialNo: _n, ...noSerial } = swapBody(m.meterId, { kind: 'reset' });
    const reset = await w.call('POST', '/api/metering/swaps', manager, noSerial);
    expect(reset.status).toBe(201);
    expect(reset.json.newMeter.serialNo).toBe('PO-1');
  });

  it('geri alma: eski sayac yeniden etkin, yeni sayac iptal; yeni sayacin onayli okumasi varsa reddedilir', async () => {
    const w = meterWorld();
    const m = await w.createMeter({ unitId: 'u1', serialNo: 'PO-OLD' });
    const { swap, newMeter } = (await w.call('POST', '/api/metering/swaps', manager, swapBody(m.meterId))).json;

    w.patchMeter(newMeter.meterId, { lastReading: { index: 30, date: '2026-11-30', periodId: 'p1' } });
    expect((await w.call('POST', `/api/metering/swaps/${swap.swapId}/reverse`, manager, { reason: 'Hatalı kayıt' })).status).toBe(422);
    w.patchMeter(newMeter.meterId, { lastReading: undefined });

    const r = await w.call('POST', `/api/metering/swaps/${swap.swapId}/reverse`, manager, { reason: 'Hatalı kayıt' });
    expect(r.status).toBe(200);
    expect(r.json.swap.status).toBe('reversed');
    expect(r.json.oldMeter).toMatchObject({ status: 'active' });
    expect(r.json.oldMeter.successorMeterId).toBeUndefined();
    expect(r.json.oldMeter.closingIndex).toBeUndefined();
    expect(r.json.newMeter.status).toBe('cancelled');
    expect((await w.call('POST', `/api/metering/swaps/${swap.swapId}/reverse`, manager, { reason: 'x' })).status).toBe(422);
    expect((await w.call('POST', `/api/metering/swaps/${swap.swapId}/reverse`, staff, { reason: 'x' })).status).toBe(403);
  });

  it('fotograf kaniti: imzali yukleme linki meters/ yolunda; yuklenmemis / baska sayaca ait anahtar reddedilir', async () => {
    const w = meterWorld();
    const m = await w.createMeter({ unitId: 'u1', serialNo: 'PO-OLD' });
    const up = await w.call('POST', `/api/metering/meters/${m.meterId}/photo-upload`, manager, { date: '2026-11-15', contentType: 'image/jpeg', size: 2048 });
    expect(up.status).toBe(201);
    expect(up.json.photoKey).toMatch(new RegExp(`^apartments/${APT}/meters/2026/11/u1/swap-${m.meterId}-.+\\.jpg$`));
    expect(up.json.uploadUrl).toContain('memory://put/');
    expect((await w.call('POST', `/api/metering/meters/${m.meterId}/photo-upload`, manager, { date: '2026-11-15', contentType: 'application/pdf', size: 10 })).status).toBe(422);
    expect((await w.call('POST', `/api/metering/meters/${m.meterId}/photo-upload`, manager, { date: '2026-11-15', contentType: 'image/png', size: 11 * 1024 * 1024 })).status).toBe(422);

    const notUploaded = await w.call('POST', '/api/metering/swaps', manager, swapBody(m.meterId, { photoKey: up.json.photoKey }));
    expect(notUploaded.status).toBe(422);
    const foreign = await w.call('POST', '/api/metering/swaps', manager, swapBody(m.meterId, { photoKey: `apartments/${APT}/meters/2026/11/u2/swap-x-1.jpg` }));
    expect(foreign.status).toBe(400);

    await w.store.put(up.json.photoKey, new Uint8Array(2048), 'image/jpeg');
    const ok = await w.call('POST', '/api/metering/swaps', manager, swapBody(m.meterId, { photoKey: up.json.photoKey }));
    expect(ok.status).toBe(201);
    const photo = await w.call('GET', `/api/metering/swaps/${ok.json.swap.swapId}/photo`, observer);
    expect(photo.json.url).toContain(`memory://get/${up.json.photoKey}`);
  });
});

describe('dagitim sablonlari (kural 1)', () => {
  it('hazir sablon: merkezi isitma %30 m2 + %70 tuketim; ilk sablon varsayilan', async () => {
    const w = meterWorld();
    const presets = await w.call('GET', '/api/metering/templates/presets', observer);
    expect(presets.json.items[0]).toMatchObject({ preset: 'central_heating', commonShareBps: 3000, commonKey: 'area', liableParty: 'occupant', warnings: [] });
    expect(presets.json.items.slice(1).map((p: { commonShareBps: number }) => p.commonShareBps)).toEqual([0, 0]);
    const r = await w.call('POST', '/api/metering/templates', manager, { preset: 'central_heating' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ meterKind: 'heat_allocator', commonShareBps: 3000, isDefault: true, warnings: [] });
  });

  it('site ayarindaki meterSplit hazir sablona yansir', async () => {
    const w = meterWorld({ meterSplit: { commonSharePercent: 30, commonShareKey: 'equal' } });
    const presets = await w.call('GET', '/api/metering/templates/presets', manager);
    expect(presets.json.items[0]).toMatchObject({ commonKey: 'equal', warnings: [{ code: 'legal_deviation' }] });
  });

  it('yonetmelik disi oran engellenmez ama karar referansi + gerekce zorunlu', async () => {
    const w = meterWorld();
    const bare = await w.call('POST', '/api/metering/templates', manager, { preset: 'central_heating', commonShareBps: 2500 });
    expect(bare.status).toBe(422);
    expect(bare.json.warnings[0].code).toBe('legal_deviation');
    const ok = await w.call('POST', '/api/metering/templates', manager, {
      preset: 'central_heating',
      commonShareBps: 2500,
      commonKey: 'equal',
      decisionRef: 'KMK kararı 2026/3',
      reason: 'Genel kurul kararı',
    });
    expect(ok.status).toBe(201);
    expect(ok.json.warnings.map((x: { code: string }) => x.code)).toEqual(['legal_deviation']);
    expect(w.audits.at(-1)).toMatchObject({ action: 'meters.template_create', reason: 'Genel kurul kararı' });
  });

  it('arsa payi anahtari site ayarinda kapaliysa reddedilir; sayac turu degistirilemez; varsayilan devri', async () => {
    const w = meterWorld();
    expect((await w.call('POST', '/api/metering/templates', manager, { preset: 'cold_water', commonKey: 'land_share' })).status).toBe(422);
    const a = (await w.call('POST', '/api/metering/templates', manager, { preset: 'cold_water' })).json;
    const b = (await w.call('POST', '/api/metering/templates', manager, { preset: 'cold_water', name: 'Soğuk su B' })).json;
    expect([a.isDefault, b.isDefault]).toEqual([true, false]);
    expect((await w.call('PUT', `/api/metering/templates/${a.templateId}`, manager, { version: 1, meterKind: 'hot_water' })).status).toBe(400);
    await w.call('POST', `/api/metering/templates/${b.templateId}/default`, manager);
    const list = (await w.call('GET', '/api/metering/templates', observer)).json.items;
    expect(list.map((t: { name: string; isDefault: boolean }) => [t.name, t.isDefault])).toEqual([
      ['Soğuk su B', true],
      ['Soğuk su — %100 tüketim', false],
    ]);
    const upd = await w.call('PUT', `/api/metering/templates/${a.templateId}`, manager, { version: 2, commonShareBps: 1000, scope: { blockIds: ['b1'] } });
    expect(upd.json).toMatchObject({ commonShareBps: 1000, scope: { blockIds: ['b1'] }, version: 3 });
    expect((await w.call('PUT', `/api/metering/templates/${a.templateId}`, manager, { version: 3, scope: { blockIds: ['yok'] } })).status).toBe(404);
    expect((await w.call('POST', `/api/metering/templates/${a.templateId}/archive`, manager, { version: 3 })).json.status).toBe('archived');
  });
});

describe('dagitim donemleri (taslak)', () => {
  async function withTemplate(w: ReturnType<typeof meterWorld>) {
    return (await w.call('POST', '/api/metering/templates', manager, { preset: 'central_heating' })).json.templateId as string;
  }

  it('taslak donem olusturma, cakisma, guncelleme ve iptal', async () => {
    const w = meterWorld();
    const templateId = await withTemplate(w);
    const body = { templateId, name: 'Kasım 2026 ısınma', startDate: '2026-11-01', endDate: '2026-11-30', dueDate: '2026-12-15', totalAmount: 1_000_000 };
    expect((await w.call('POST', '/api/metering/periods', staff, body)).status).toBe(403);
    const r = await w.call('POST', '/api/metering/periods', manager, body);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ status: 'draft', meterKind: 'heat_allocator', accrualDate: '2026-11-30', template: { commonShareBps: 3000, version: 1 } });
    expect((await w.call('POST', '/api/metering/periods', manager, { ...body, startDate: '2026-11-20', endDate: '2026-12-10', dueDate: '2026-12-20' })).status).toBe(409);
    expect((await w.call('POST', '/api/metering/periods', manager, { ...body, dueDate: '2026-11-10' })).status).toBe(400);

    const upd = await w.call('PATCH', `/api/metering/periods/${r.json.periodId}`, manager, { version: 1, endDate: '2026-11-29', totalAmount: null });
    expect(upd.json).toMatchObject({ endDate: '2026-11-29', accrualDate: '2026-11-29', version: 2 });
    expect(upd.json.totalAmount).toBeUndefined();
    const cancel = await w.call('POST', `/api/metering/periods/${r.json.periodId}/cancel`, manager, { version: 2, reason: 'Yanlış açıldı' });
    expect(cancel.json.status).toBe('cancelled');
    // Iptal edilen donem cakisma sayilmaz.
    expect((await w.call('POST', '/api/metering/periods', manager, body)).status).toBe(201);
    expect((await w.call('GET', '/api/metering/periods?status=open', observer)).json.items).toHaveLength(1);
  });
});
