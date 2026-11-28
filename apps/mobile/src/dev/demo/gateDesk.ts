import { addDays, istanbulDay } from '@bm/shared/gate/plate';
import type { DemoHandler } from '../demoApi';
import { bodyOf, fail, ok } from './types';

/*
 * DEMO: guvenlik gorevlisi kapi masasi (security_guard; sakin tarafi: gate.ts). Kisa kodlar: K7M2-PQ4X gecerli (tek giris), ABCD-2345
 * suresi dolmus; baska kod "bulunamadi" ve 5 hatali denemede 429 (deneme siniri, geri sayim).
 * Plakalar: 34 ABC 123 (A Blok 7, aktif), 06 XY 4512 (B Blok 2, pasif). Kurye kaydi 20 sn sonra
 * sakin tarafindan "onaylanir" (canli durum).
 */

const UNITS = [
  { unitId: 'u-a-1', label: 'A Blok · Daire 1' },
  { unitId: 'u-a-2', label: 'A Blok · Daire 2' },
  { unitId: 'u-demo-7', label: 'A Blok · Daire 7' },
  { unitId: 'u-b-2', label: 'B Blok · Daire 2' },
  { unitId: 'u-b-5', label: 'B Blok · Daire 5' },
  { unitId: 'u-c-12', label: 'C Blok · Daire 12' },
];

const PLATES = [
  { plate: '34ABC123', plateDisplay: '34 ABC 123', unitId: 'u-demo-7', unitLabel: 'A Blok · Daire 7', registered: true, active: true, note: 'Gri sedan' },
  { plate: '06XY4512', plateDisplay: '06 XY 4512', unitId: 'u-b-2', unitLabel: 'B Blok · Daire 2', registered: true, active: false },
];

type Json = Record<string, unknown>;

export function createGateDeskDemo(): DemoHandler {
  let failures = 0;
  let lockedUntil = 0;
  let seq = 0;
  const passes: Record<string, Json> = {};
  const couriers: Json[] = [];
  const log: Json[] = [];

  const addLog = (entry: Json, now: Date) => {
    const e = { logId: `log-${++seq}`, at: now.toISOString(), recordedByName: 'Siz', ...entry };
    log.unshift(e);
    return e;
  };

  const passFor = (code: string, now: Date): Json | undefined => {
    const today = istanbulDay(now);
    if (code === 'K7M2PQ4X') {
      passes['p-valid'] ??= {
        passId: 'p-valid', unitId: 'u-demo-7', unitLabel: 'A Blok · Daire 7', guestName: 'Ayşe Yılmaz', validFrom: today, validUntil: today, entryMode: 'single',
        plate: '34KLM778', plateDisplay: '34 KLM 778', note: 'Akşam yemeğine geliyor', verdict: 'valid', entryCount: 0, inside: false, canEnter: true, canExit: false, version: 1,
      };
      return passes['p-valid'];
    }
    if (code === 'ABCD2345') {
      return {
        passId: 'p-expired', unitId: 'u-b-5', unitLabel: 'B Blok · Daire 5', guestName: 'Mehmet Kaya', validFrom: addDays(today, -3), validUntil: addDays(today, -1), entryMode: 'multi',
        verdict: 'expired', message: 'Geçişin süresi dolmuş.', entryCount: 2, inside: false, canEnter: false, canExit: false, version: 3,
      };
    }
    return undefined;
  };

  /** 20 sn sonra sakin "onaylar"; onayin gecerliligi 15 dk. */
  const tick = (now: Date) => {
    for (const c of couriers) {
      if (c.status === 'waiting' && now.getTime() - Date.parse(String(c.createdAt)) > 20_000) {
        c.status = 'approved';
        c.respondedAt = now.toISOString();
        c.enterBy = new Date(now.getTime() + 15 * 60_000).toISOString();
        c.canEnter = true;
        c.canCancel = true;
        c.version = Number(c.version) + 1;
      }
    }
  };

  return ({ method, path, query, body: raw, claims, now }) => {
    const body = bodyOf(raw);
    if (!path.startsWith('/api/gate')) return undefined;
    if (claims.role !== 'security_guard') return fail(403, 'forbidden', 'Bu işlem için yetkiniz yok.');

    if (path === '/api/gate/units') {
      const q = (query.q ?? '').toLocaleLowerCase('tr-TR');
      return ok({ items: UNITS.filter((u) => !q || u.label.toLocaleLowerCase('tr-TR').includes(q)) });
    }
    if (path === '/api/gate/plates') {
      const q = query.q ?? '';
      const items = PLATES.filter((p) => p.plate === q || p.plate.endsWith(q)).map((p) => ({ ...p, exact: p.plate === q }));
      return ok({ query: q, queryDisplay: q, items });
    }
    if (path === '/api/gate/passes/verify' && method === 'POST') {
      if (now.getTime() < lockedUntil) {
        const s = Math.ceil((lockedUntil - now.getTime()) / 1000);
        return fail(429, 'rate_limited', `Çok fazla geçiş sorgusu yapıldı. Güvenlik nedeniyle ${Math.ceil(s / 60)} dakika sonra tekrar deneyin.`, { retryAfterSeconds: s });
      }
      const pass = passFor(String(body.code ?? ''), now);
      if (!pass) {
        failures += 1;
        if (failures >= 5) lockedUntil = now.getTime() + 2 * 60_000;
        return fail(404, 'not_found', 'Geçiş bulunamadı. Kodu kontrol edin.');
      }
      failures = 0;
      return ok({ pass });
    }
    const passMove = /^\/api\/gate\/passes\/([^/]+)\/(entry|exit)$/.exec(path);
    if (passMove && method === 'POST') {
      const p = passes[passMove[1] ?? ''];
      if (!p) return fail(409, 'pass_expired', 'Geçişin süresi dolmuş.');
      const entry = passMove[2] === 'entry';
      Object.assign(p, entry ? { inside: true, entryCount: Number(p.entryCount) + 1, lastEntryAt: now.toISOString(), canEnter: false, canExit: true, verdict: 'used' } : { inside: false, canExit: false });
      p.version = Number(p.version) + 1;
      return ok({ pass: p, log: addLog({ direction: entry ? 'entry' : 'exit', kind: 'guest', unitId: p.unitId, unitLabel: p.unitLabel, passId: p.passId, visitorName: p.guestName, plateDisplay: p.plateDisplay }, now) });
    }

    if (path === '/api/gate/couriers' && method === 'GET') {
      tick(now);
      const open = query.status !== 'all';
      return ok({ items: couriers.filter((c) => !open || (!c.exitedAt && c.status !== 'cancelled' && c.status !== 'declined')), pollSeconds: 15 });
    }
    if (path === '/api/gate/couriers' && method === 'POST') {
      const unit = UNITS.find((u) => u.unitId === body.unitId);
      if (!unit) return fail(404, 'not_found', 'Bağımsız bölüm bulunamadı.');
      const c: Json = {
        courierId: `c-${++seq}`, unitId: unit.unitId, unitLabel: unit.label, ...(body.company ? { company: body.company } : {}), ...(body.note ? { note: body.note } : {}),
        status: 'waiting', expired: false, respondBy: new Date(now.getTime() + 10 * 60_000).toISOString(), createdAt: now.toISOString(),
        canRespond: false, canEnter: false, canExit: false, canCancel: true, version: 1,
      };
      couriers.unshift(c);
      return { status: 201, body: { courier: c } };
    }
    const courierAct = /^\/api\/gate\/couriers\/([^/]+)\/(entry|exit|cancel)$/.exec(path);
    if (courierAct && method === 'POST') {
      const c = couriers.find((x) => x.courierId === courierAct[1]);
      if (!c) return fail(404, 'not_found', 'Kurye kaydı bulunamadı.');
      const kind = courierAct[2];
      if (kind === 'cancel') Object.assign(c, { status: 'cancelled', canEnter: false, canCancel: false });
      if (kind === 'entry') Object.assign(c, { enteredAt: now.toISOString(), canEnter: false, canCancel: false, canExit: true });
      if (kind === 'exit') Object.assign(c, { exitedAt: now.toISOString(), canExit: false });
      c.version = Number(c.version) + 1;
      const entryLog = kind === 'cancel' ? undefined : addLog({ direction: kind === 'entry' ? 'entry' : 'exit', kind: 'courier', unitId: c.unitId, unitLabel: c.unitLabel, courierId: c.courierId, company: c.company }, now);
      return ok({ courier: c, ...(entryLog ? { log: entryLog } : {}) });
    }

    if (path === '/api/gate/log' && method === 'POST') {
      const unit = UNITS.find((u) => u.unitId === body.unitId);
      const entry = addLog({ direction: body.direction, kind: 'manual', visitorName: body.visitorName, ...(unit ? { unitId: unit.unitId, unitLabel: unit.label } : {}), ...(body.plate ? { plate: body.plate, plateDisplay: body.plate } : {}), ...(body.note ? { note: body.note } : {}) }, now);
      return { status: 201, body: { log: entry, replayed: false } };
    }
    if (path === '/api/gate/log' && method === 'GET') {
      const kind = query.kind;
      const seed = [
        { logId: 'log-s2', at: new Date(now.getTime() - 50 * 60_000).toISOString(), direction: 'exit', kind: 'courier', unitId: 'u-a-2', unitLabel: 'A Blok · Daire 2', company: 'Trendyol', recordedByName: 'Gece görevlisi' },
        { logId: 'log-s1', at: new Date(now.getTime() - 55 * 60_000).toISOString(), direction: 'entry', kind: 'courier', unitId: 'u-a-2', unitLabel: 'A Blok · Daire 2', company: 'Trendyol', recordedByName: 'Gece görevlisi' },
        { logId: 'log-s0', at: new Date(now.getTime() - 20 * 3600_000).toISOString(), direction: 'entry', kind: 'manual', visitorName: 'Asansör servisi', plateDisplay: '34 SRV 210', note: 'Periyodik bakım', recordedByName: 'Gündüz görevlisi' },
      ];
      const items = [...log, ...seed].filter((e) => !kind || e.kind === kind);
      const today = istanbulDay(now);
      return ok({ items, from: addDays(today, -1), to: today });
    }
    return undefined;
  };
}
