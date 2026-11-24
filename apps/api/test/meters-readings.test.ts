import { describe, expect, it } from 'vitest';
import { formatIndex, parseIndexText } from '../src/modules/meters/common.js';
import { APT, manager, meterWorld, observer, resident, staff } from './fakes/meterWorld.js';

/**
 * Kurulum: merkezi isitma sablonu (dukkan `heating` muafiyetiyle kapsam disi), Kasim 2026 donemi,
 * sayaclar: m1 (u1, son onayli okuma 100 / 31.10, gecmis 10 birim / 30 gun), m2 (u2, acilis 0),
 * m3 (u3 dukkan, kapsam disi).
 */
async function setup() {
  const w = meterWorld();
  const tpl = (await w.call('POST', '/api/metering/templates', manager, { preset: 'central_heating', scope: { exemptionCategory: 'heating' } })).json;
  const m1 = await w.createMeter({ unitId: 'u1', label: 'Salon', serialNo: 'PO-1', openingIndex: 0 });
  const m2 = await w.createMeter({ unitId: 'u2', label: 'Salon', serialNo: 'PO-2', openingIndex: 0 });
  const m3 = await w.createMeter({ unitId: 'u3', label: 'Dükkan', serialNo: 'PO-3', openingIndex: 0 });
  w.patchMeter(m1.meterId, { lastReading: { index: 100, date: '2026-10-31', periodId: 'p-ekim' }, recentConsumption: [{ delta: 10, days: 30, periodId: 'p-ekim' }] });
  const period = (
    await w.call('POST', '/api/metering/periods', manager, { templateId: tpl.templateId, name: 'Kasım 2026', startDate: '2026-11-01', endDate: '2026-11-30', dueDate: '2026-12-15' })
  ).json;
  const url = `/api/meter-readings/periods/${period.periodId}`;
  const sheet = async (who = manager) => (await w.call('GET', url, who)).json;
  const rowOf = async (meterId: string) => (await sheet()).rows.find((r: { meterId: string }) => r.meterId === meterId);
  return { w, tpl, m1, m2, m3, period, url, sheet, rowOf };
}

describe('okuma cetveli', () => {
  it('baslangic endeksi, kapsam ve eksik okumalar; tahmin onerisi gecmisten', async () => {
    const { m1, m2, m3, sheet } = await setup();
    const s = await sheet(staff);
    const byId = Object.fromEntries(s.rows.map((r: { meterId: string }) => [r.meterId, r]));
    expect(byId[m1.meterId]).toMatchObject({ status: 'missing', startIndex: 100, startSource: 'last_reading', inScope: true, suggestion: { suggestedDelta: 10, suggestedEndIndex: 110 } });
    expect(byId[m2.meterId]).toMatchObject({ status: 'missing', startIndex: 0, startSource: 'opening', inScope: true });
    expect(byId[m2.meterId].suggestion).toBeUndefined();
    expect(byId[m3.meterId]).toMatchObject({ inScope: false });
    expect(s.summary).toMatchObject({ meters: 2, missing: 2, ok: 0, outOfScope: 1 });
    expect(s.period.PK).toBeUndefined();
  });

  it('okuma ucu yetkileri: gorevli ve denetci okur, sakin okuyamaz; denetci yazamaz', async () => {
    const { w, url, m2 } = await setup();
    expect((await w.call('GET', url, observer)).status).toBe(200);
    expect((await w.call('GET', url, resident)).status).toBe(403);
    expect((await w.call('PUT', url, observer, { items: [{ meterId: m2.meterId, endIndex: 5 }] })).status).toBe(403);
    expect((await w.call('GET', '/api/meter-readings/periods', staff)).json.items).toHaveLength(1);
  });
});

describe('okuma girisi - dogrulama ve uyarilar', () => {
  it('gorevli toplu giris yapar; fark ve kaynak kaydedilir, denetim yazilir', async () => {
    const { w, url, m1, m2, rowOf } = await setup();
    const r = await w.call('PUT', url, staff, { items: [{ meterId: m1.meterId, endIndex: 125 }, { meterId: m2.meterId, endIndex: 80, note: 'Kapı önünde okundu' }] });
    expect(r.status).toBe(200);
    expect(r.json.items.map((i: { meterId: string; delta: number }) => [i.meterId, i.delta])).toEqual([
      [m1.meterId, 25],
      [m2.meterId, 80],
    ]);
    expect(r.json.period).toMatchObject({ status: 'draft', version: 2 });
    expect(await rowOf(m2.meterId)).toMatchObject({ status: 'ok', endIndex: 80, delta: 80, reading: { source: 'staff', note: 'Kapı önünde okundu', rev: 1 } });
    expect(w.audits.at(-1)).toMatchObject({ action: 'meters.readings_save', target: { type: 'meter_period' }, details: { count: 2, source: 'staff' } });

    // Ikinci giris ayni kaydi gunceller (rev 2), not korunur.
    await w.call('PUT', url, manager, { items: [{ meterId: m2.meterId, endIndex: 82 }] });
    expect(await rowOf(m2.meterId)).toMatchObject({ endIndex: 82, reading: { source: 'manual', note: 'Kapı önünde okundu', rev: 2, version: 2 } });
  });

  it('geri giden endeks engelleyici hatadir; hep-ya-hic: gecerli satir da yazilmaz', async () => {
    const { w, url, m1, m2, rowOf } = await setup();
    const r = await w.call('PUT', url, staff, { items: [{ meterId: m2.meterId, endIndex: 50 }, { meterId: m1.meterId, endIndex: 90 }] });
    expect(r.status).toBe(422);
    expect(r.json.items).toEqual([expect.objectContaining({ ref: 1, meterId: m1.meterId, code: 'negative_delta' })]);
    expect((await rowOf(m2.meterId)).status).toBe('missing');
  });

  it('sicrama uyaridir: okuma kaydedilir, spike bayragi doner', async () => {
    const { w, url, m1, rowOf } = await setup();
    // Gecmis: 10 birim / 30 gun; Kasim 30 gun -> beklenen 10; 3 kati 30. Fark 31 -> sicrama.
    const r = await w.call('PUT', url, staff, { items: [{ meterId: m1.meterId, endIndex: 131 }] });
    expect(r.status).toBe(200);
    expect(r.json.items[0].flags).toEqual(['spike']);
    expect(r.json.warnings).toEqual([{ meterId: m1.meterId, code: 'spike' }]);
    expect(await rowOf(m1.meterId)).toMatchObject({ status: 'ok', flags: ['spike'] });
    const normal = await w.call('PUT', url, staff, { items: [{ meterId: m1.meterId, endIndex: 130 }] });
    expect(normal.json.items[0].flags).toEqual([]);
  });

  it('tahmini okuma ve tur atma yalnizca yonetici onayiyla', async () => {
    const { w, url, m1, m2, rowOf } = await setup();
    const byStaff = await w.call('PUT', url, staff, { items: [{ meterId: m1.meterId, acceptEstimate: true }] });
    expect(byStaff.status).toBe(422);
    expect(byStaff.json.items[0].code).toBe('manager_only');
    const noHistory = await w.call('PUT', url, manager, { items: [{ meterId: m2.meterId, acceptEstimate: true }] });
    expect(noHistory.json.items[0].code).toBe('no_estimate');
    const est = await w.call('PUT', url, manager, { items: [{ meterId: m1.meterId, acceptEstimate: true }] });
    expect(est.status).toBe(200);
    expect(await rowOf(m1.meterId)).toMatchObject({ endIndex: 110, flags: ['estimated'], reading: { estimated: true, source: 'estimate' } });

    const ro = await w.createMeter({ unitId: 'u2', label: 'Oda', openingIndex: 9990, maxIndex: 9999 });
    const plain = await w.call('PUT', url, manager, { items: [{ meterId: ro.meterId, endIndex: 5 }] });
    expect(plain.json.items[0].code).toBe('negative_delta');
    const staffRoll = await w.call('PUT', url, staff, { items: [{ meterId: ro.meterId, endIndex: 5, rolloverConfirmed: true }] });
    expect(staffRoll.json.items[0].code).toBe('manager_only');
    const roll = await w.call('PUT', url, manager, { items: [{ meterId: ro.meterId, endIndex: 5, rolloverConfirmed: true }] });
    expect(roll.json.items[0]).toMatchObject({ delta: 15, flags: ['rollover'] });
    expect((await w.call('PUT', url, manager, { items: [{ meterId: ro.meterId, endIndex: 10000 }] })).json.items[0].code).toBe('invalid_index');
  });

  it('kapsam disi, degistirilmis sayac, mukerrer ve bilinmeyen sayac satir hatalari', async () => {
    const { w, url, m1, m3 } = await setup();
    const swap = await w.call('POST', '/api/metering/swaps', manager, {
      idempotencyKey: 'swap-key-0001',
      meterId: m1.meterId,
      kind: 'reset',
      swapDate: '2026-11-15',
      oldClosingIndex: 140,
      newOpeningIndex: 0,
      reason: 'Sıfırlandı',
    });
    const newId = swap.json.newMeter.meterId;
    const r = await w.call('PUT', url, manager, {
      items: [
        { meterId: m3.meterId, endIndex: 5 },
        { meterId: m1.meterId, endIndex: 150 },
        { meterId: newId, endIndex: 7 },
        { meterId: newId, endIndex: 8 },
        { meterId: 'yok', endIndex: 1 },
      ],
    });
    expect(r.status).toBe(422);
    expect(r.json.items.map((e: { ref: number; code: string }) => [e.ref, e.code])).toEqual([
      [0, 'unit_out_of_scope'],
      [1, 'reading_not_needed'],
      [3, 'duplicate'],
      [4, 'meter_not_in_period'],
    ]);
    // Degisim sonrasi cetvel: eski sayac kapanisla otomatik (40), yeni sayac acilistan okunur.
    await w.call('PUT', url, manager, { items: [{ meterId: newId, endIndex: 7 }] });
    const s = (await w.call('GET', url, manager)).json;
    const byId = Object.fromEntries(s.rows.map((x: { meterId: string }) => [x.meterId, x]));
    expect(byId[m1.meterId]).toMatchObject({ status: 'auto', endSource: 'swap_closing', delta: 40 });
    expect(byId[newId]).toMatchObject({ status: 'ok', startSource: 'swap_opening', delta: 7 });
  });

  it('acik olmayan doneme okuma girilemez', async () => {
    const { w, url, period, m2 } = await setup();
    await w.call('POST', `/api/metering/periods/${period.periodId}/cancel`, manager, { version: 1, reason: 'İptal' });
    expect((await w.call('PUT', url, manager, { items: [{ meterId: m2.meterId, endIndex: 5 }] })).status).toBe(422);
  });

  it('degisim kapanisi acik donemdeki okumadan kucuk olamaz', async () => {
    const { w, url, m2 } = await setup();
    await w.call('PUT', url, manager, { items: [{ meterId: m2.meterId, endIndex: 80 }] });
    w.setNow('2026-12-10T09:00:00.000Z');
    const r = await w.call('POST', '/api/metering/swaps', manager, {
      idempotencyKey: 'swap-key-0002',
      meterId: m2.meterId,
      kind: 'replacement',
      swapDate: '2026-12-05',
      oldClosingIndex: 70,
      newOpeningIndex: 0,
      reason: 'Değişti',
    });
    expect(r.status).toBe(422);
  });
});

describe('toplu endeks aktarimi (Excel/CSV)', () => {
  it('onizleme: seri no ile eslesme, Turkce sayi bicimi, satir hatalari', async () => {
    const { w, url, m1, m2 } = await setup();
    const dec = await w.createMeter({ unitId: 'u1', label: 'Su', kind: 'heat_allocator', serialNo: 'SU-1', scale: 3, openingIndex: 1000 });
    const r = await w.call('POST', `${url}/import`, staff, {
      dryRun: true,
      rows: [
        { row: 2, meter: 'po-1', index: '120' },
        { row: 3, meter: 'PO-2', index: '1.234' },
        { row: 4, meter: 'SU-1', index: '1,5' },
        { row: 5, meter: 'YOK-9', index: '5' },
        { row: 6, meter: m2.meterId, index: 'abc' },
        { row: 7, meter: 'SU-1', index: '1,2345' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ dryRun: true, valid: 3 });
    expect(r.json.rows.map((x: { meterId: string; endIndex: number; delta: number }) => [x.meterId, x.endIndex, x.delta])).toEqual([
      [m1.meterId, 120, 20],
      [m2.meterId, 1234, 1234],
      [dec.meterId, 1500, 500],
    ]);
    expect(r.json.errors.map((e: { ref: number; code: string }) => [e.ref, e.code])).toEqual([
      [5, 'meter_not_found'],
      [6, 'invalid_index'],
      [7, 'invalid_index'],
    ]);
    expect((await w.call('GET', url, manager)).json.summary.ok).toBe(0);
  });

  it('hatali satir varken aktarim yapilmaz; hatasizsa yazilir', async () => {
    const { w, url, m1, m2, rowOf } = await setup();
    const bad = await w.call('POST', `${url}/import`, manager, { rows: [{ row: 2, meter: 'PO-1', index: '90' }, { row: 3, meter: 'PO-2', index: '10' }] });
    expect(bad.status).toBe(422);
    expect(bad.json.items[0]).toMatchObject({ ref: 2, code: 'negative_delta' });
    const ok = await w.call('POST', `${url}/import`, manager, { rows: [{ row: 2, meter: 'PO-1', index: '120' }, { row: 3, meter: 'PO-2', index: '10' }] });
    expect(ok.json).toMatchObject({ dryRun: false, imported: 2 });
    expect(await rowOf(m1.meterId)).toMatchObject({ endIndex: 120, reading: { source: 'import' } });
    expect((await rowOf(m2.meterId)).status).toBe('ok');
    expect(w.audits.at(-1)?.action).toBe('meters.readings_import');
  });
});

describe('okuma fotograf kaniti (S3 imzali URL)', () => {
  it('yukleme linki meters/{yyyy}/{mm}/{unitId}/ altinda; yuklenen fotograf okumaya baglanir ve goruntulenir', async () => {
    const { w, url, period, m1, m2, rowOf } = await setup();
    const up = await w.call('POST', `${url}/meters/${m1.meterId}/photo-upload`, staff, { contentType: 'image/heic', size: 4096 });
    expect(up.status).toBe(201);
    expect(up.json.photoKey).toMatch(new RegExp(`^apartments/${APT}/meters/2026/11/u1/${period.periodId}-${m1.meterId}-.+\\.heic$`));
    expect(up.json).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/heic' } });

    const early = await w.call('PUT', url, staff, { items: [{ meterId: m1.meterId, endIndex: 120, photoKey: up.json.photoKey }] });
    expect(early.json.items[0].code).toBe('invalid_photo');
    await w.store.put(up.json.photoKey, new Uint8Array(4096), 'image/heic');
    const wrongMeter = await w.call('PUT', url, staff, { items: [{ meterId: m2.meterId, endIndex: 5, photoKey: up.json.photoKey }] });
    expect(wrongMeter.json.items[0].code).toBe('invalid_photo');
    const ok = await w.call('PUT', url, staff, { items: [{ meterId: m1.meterId, endIndex: 120, photoKey: up.json.photoKey }] });
    expect(ok.status).toBe(200);
    expect((await rowOf(m1.meterId)).reading.hasPhoto).toBe(true);

    const photo = await w.call('GET', `${url}/meters/${m1.meterId}/photo`, observer);
    expect(photo.status).toBe(200);
    expect(photo.json).toMatchObject({ contentType: 'image/heic' });
    expect(photo.json.url).toContain(`memory://get/${up.json.photoKey}`);
    expect((await w.call('GET', `${url}/meters/${m2.meterId}/photo`, observer)).status).toBe(404);

    // Fotograf kaldirma (null), okuma korunur.
    await w.call('PUT', url, manager, { items: [{ meterId: m1.meterId, endIndex: 120, photoKey: null }] });
    expect((await rowOf(m1.meterId)).reading.hasPhoto).toBe(false);
  });

  it('kapsam disi / degistirilmis sayac icin yukleme linki verilmez', async () => {
    const { w, url, m3 } = await setup();
    const r = await w.call('POST', `${url}/meters/yok/photo-upload`, staff, { contentType: 'image/jpeg', size: 10 });
    expect(r.status).toBe(422);
    // Kapsam disi sayac yine de cetvelde; yukleme linki verilebilir ama okuma satiri reddedilir.
    const out = await w.call('POST', `${url}/meters/${m3.meterId}/photo-upload`, staff, { contentType: 'image/jpeg', size: 10 });
    expect(out.status).toBe(201);
  });
});

describe('endeks metni ayristirma', () => {
  it('Turkce / nokta ondalik / binlik bicimleri olcege gore', () => {
    expect(parseIndexText('1234', 0)).toEqual({ ok: true, value: 1234 });
    expect(parseIndexText('1.234', 0)).toEqual({ ok: true, value: 1234 });
    expect(parseIndexText('1.234', 3)).toEqual({ ok: true, value: 1234 });
    expect(parseIndexText('1.234,567', 3)).toEqual({ ok: true, value: 1234567 });
    expect(parseIndexText('12,5', 2)).toEqual({ ok: true, value: 1250 });
    expect(parseIndexText(' 0012 ', 1)).toEqual({ ok: true, value: 120 });
    expect(parseIndexText('12,345', 2).ok).toBe(false);
    expect(parseIndexText('1,2,3', 3).ok).toBe(false);
    expect(parseIndexText('12.34', 0).ok).toBe(false);
    expect(parseIndexText('-5', 0).ok).toBe(false);
    expect(parseIndexText('', 0).ok).toBe(false);
  });

  it('gosterim', () => {
    expect(formatIndex(123456, 3)).toBe('123,456');
    expect(formatIndex(5, 2)).toBe('0,05');
    expect(formatIndex(42, 0)).toBe('42');
  });
});
