import { formatPlate, isTurkishPlate, normalizePlate, passFormError } from '@bm/shared/api/portalGate';
import { istanbulToday } from '@bm/shared/reservations/model';
import type { DemoHandler } from '../demoApi';

/*
 * DEMO: sakin "Ziyaretçi" (/api/portal/gate). Acilista kapida onay bekleyen bir kurye, iki misafir
 * gecisi, bir arac ve son kapi kayitlari vardir; islemler bellekte. QR jetonu yalnizca olusturma /
 * yenileme yanitinda doner (gercek API gibi). Gercek veri DEGILDIR.
 */

type Json = Record<string, unknown>;
type Pass = Json & { passId: string; version: number; status: string; validFrom: string; validUntil: string };

const P = '/api/portal/gate';
const UNIT = { unitId: 'u-demo-7', unitLabel: 'A Blok · Daire 7' };
const LIMITS = { maxVehiclesPerUnit: 4, maxPassDays: 31, maxPassLeadDays: 90, courierResponseMinutes: 60 };
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

const pick = (chars: string, n: number) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function createGateDemo(now0: Date = new Date()): DemoHandler {
  const today0 = istanbulToday(now0);
  const iso = (msAgo: number) => new Date(now0.getTime() - msAgo).toISOString();
  const courier: Json = {
    courierId: 'c-1',
    ...UNIT,
    company: 'Yemeksepeti',
    note: 'Sipariş teslimatı, kapıda bekliyor',
    status: 'waiting',
    expired: false,
    createdAt: iso(3 * 60_000),
    respondBy: new Date(now0.getTime() + 57 * 60_000).toISOString(),
    canRespond: true,
    canEnter: false,
    canExit: false,
    canCancel: false,
    version: 1,
  };
  const base = { ...UNIT, entryCount: 0, inside: false, mine: true, createdAt: iso(86_400_000), version: 1 };
  const passes: Pass[] = [
    { ...base, passId: 'ps-2', guestName: 'Mehmet Yılmaz', validFrom: today0, validUntil: addDays(today0, 2), entryMode: 'multi', status: 'active', verdict: 'valid', entryCount: 1, inside: true, lastEntryAt: iso(2 * 3_600_000), canRevoke: true, canRotate: true },
    { ...base, passId: 'ps-1', guestName: 'Ayşe Demir', validFrom: addDays(today0, -3), validUntil: addDays(today0, -3), entryMode: 'single', status: 'used', verdict: 'used', entryCount: 1, canRevoke: false, canRotate: false },
  ];
  const vehicles: Json[] = [
    { vehicleId: 'v-1', ...UNIT, plate: '34ABC123', plateDisplay: '34 ABC 123', note: 'Beyaz Fiat Egea', status: 'active', createdAt: iso(30 * 86_400_000), updatedAt: iso(30 * 86_400_000), createdByRole: 'resident', version: 1 },
  ];
  const log: Json[] = [
    { logId: 'l-3', at: iso(2 * 3_600_000), direction: 'entry', kind: 'guest', ...UNIT, passId: 'ps-2', visitorName: 'Mehmet Yılmaz' },
    { logId: 'l-2', at: iso(26 * 3_600_000), direction: 'exit', kind: 'courier', ...UNIT, company: 'Trendyol', visitorName: 'Kurye' },
    { logId: 'l-1', at: iso(26.2 * 3_600_000), direction: 'entry', kind: 'courier', ...UNIT, company: 'Trendyol', visitorName: 'Kurye' },
  ];
  let seq = 3;
  const conflict = { status: 409, body: { error: 'conflict', message: 'Kayıt bu arada güncellendi; yenileyip tekrar deneyin.' } };
  const view = (p: Pass) => {
    const { token: _t, shortCode: _s, ...rest } = p;
    return rest;
  };

  return ({ method, path, body, now }) => {
    if (!path.startsWith(P)) return undefined;
    const rest = path.slice(P.length);
    const b = (body ?? {}) as Json;
    const today = istanbulToday(now);

    if (rest === '') return { status: 200, body: { units: [{ unitId: UNIT.unitId, label: UNIT.unitLabel }], limits: LIMITS } };
    if (rest === '/couriers') return { status: 200, body: { items: [courier], pollSeconds: 15 } };
    if (rest === '/passes' && method === 'GET') return { status: 200, body: { items: passes.map(view) } };
    if (rest === '/vehicles' && method === 'GET') return { status: 200, body: { items: vehicles, maxPerUnit: LIMITS.maxVehiclesPerUnit } };
    if (rest === '/log') return { status: 200, body: { items: log, from: addDays(today, -7), to: today } };

    if (rest === '/passes' && method === 'POST') {
      const validFrom = String(b.validFrom ?? '');
      const validUntil = typeof b.validUntil === 'string' ? b.validUntil : validFrom;
      const problem = passFormError({ guestName: String(b.guestName ?? ''), validFrom, validUntil: typeof b.validUntil === 'string' ? b.validUntil : '', today, maxPassDays: LIMITS.maxPassDays, maxPassLeadDays: LIMITS.maxPassLeadDays });
      if (problem) return { status: 400, body: { error: 'validation', message: problem } };
      const pass: Pass = {
        ...base,
        createdAt: now.toISOString(),
        passId: `ps-${seq++}`,
        guestName: String(b.guestName),
        validFrom,
        validUntil,
        entryMode: b.entryMode === 'multi' ? 'multi' : 'single',
        ...(typeof b.plate === 'string' && b.plate ? { plate: b.plate, plateDisplay: formatPlate(b.plate) } : {}),
        ...(typeof b.note === 'string' ? { note: b.note } : {}),
        status: 'active',
        verdict: validFrom > today ? 'not_yet_valid' : 'valid',
        canRevoke: true,
        canRotate: true,
        token: pick(TOKEN_CHARS, 24),
        shortCode: pick(ALPHABET, 8),
      };
      passes.unshift(pass);
      return { status: 201, body: { pass, replayed: false } };
    }

    const [, kind = '', id = '', action] = rest.split('/').map(decodeURIComponent);
    if (kind === 'couriers' && action === 'respond') {
      if (b.version !== courier.version) return conflict;
      Object.assign(courier, { status: b.decision === 'approve' ? 'approved' : 'declined', respondedAt: now.toISOString(), canRespond: false, version: Number(courier.version) + 1 });
      return { status: 200, body: { courier } };
    }
    if (kind === 'passes') {
      const p = passes.find((x) => x.passId === id);
      if (!p) return { status: 404, body: { error: 'not_found', message: 'Geçiş bulunamadı.' } };
      if (b.version !== p.version) return conflict;
      if (action === 'revoke') {
        Object.assign(p, { status: 'revoked', verdict: 'revoked', revokedAt: now.toISOString(), canRevoke: false, canRotate: false, version: p.version + 1 });
        return { status: 200, body: { pass: view(p) } };
      }
      if (action === 'rotate') {
        Object.assign(p, { version: p.version + 1 });
        return { status: 200, body: { pass: { ...view(p), token: pick(TOKEN_CHARS, 24), shortCode: pick(ALPHABET, 8) } } };
      }
    }
    if (rest === '/vehicles' && method === 'POST') {
      const plate = normalizePlate(String(b.plate ?? ''));
      if (!isTurkishPlate(plate)) return { status: 400, body: { error: 'validation', message: 'Plaka Türkiye plaka biçiminde olmalıdır', field: 'plate' } };
      if (vehicles.some((v) => v.plate === plate)) return { status: 409, body: { error: 'conflict', message: 'Bu plaka zaten kayıtlı.' } };
      if (vehicles.filter((v) => v.status === 'active').length >= LIMITS.maxVehiclesPerUnit) return { status: 422, body: { error: 'unprocessable', message: `Bir daireye en fazla ${LIMITS.maxVehiclesPerUnit} aktif araç kaydedilebilir.` } };
      const vehicle = { vehicleId: `v-${seq++}`, ...UNIT, plate, plateDisplay: formatPlate(plate), ...(typeof b.note === 'string' ? { note: b.note } : {}), status: 'active', createdAt: now.toISOString(), updatedAt: now.toISOString(), createdByRole: 'resident', version: 1 };
      vehicles.unshift(vehicle);
      return { status: 201, body: { vehicle } };
    }
    if (kind === 'vehicles' && method === 'PATCH') {
      const v = vehicles.find((x) => x.vehicleId === id);
      if (!v) return { status: 404, body: { error: 'not_found', message: 'Araç bulunamadı.' } };
      if (b.version !== v.version) return conflict;
      Object.assign(v, { ...(b.status ? { status: b.status } : {}), updatedAt: now.toISOString(), version: Number(v.version) + 1 });
      return { status: 200, body: { vehicle: v } };
    }
    return undefined;
  };
}
