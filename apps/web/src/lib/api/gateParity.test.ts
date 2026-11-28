import * as shared from '@bm/shared/api/portalGate';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
vi.mock('./client', () => ({ apiClient: {} }));
const web = await import('./gate');
const plate = await import('@/lib/gate/plate');
const pass = await import('@/lib/gate/pass');

/*
 * Gecici esitlik testi: sakin kapi semalari ve yardimcilari su an web (lib/api/gate.ts, lib/gate/*) ve
 * ortak pakette (packages/shared/src/api/portalGate.ts, mobil kullanir) iki kopya. Tek kaynaga
 * indirilene kadar sekil veya davranis ayrilirsa bu test kirilir.
 */

const json = (s: z.ZodType) => z.toJSONSchema(s);

describe('sakin kapi: web ve ortak paket esit', () => {
  it('semalar ayni sekilde', () => {
    expect(json(shared.gateUnitSchema)).toEqual(json(web.unitOptionSchema));
    expect(json(shared.vehicleSchema)).toEqual(json(web.vehicleSchema));
    expect(json(shared.myPassSchema)).toEqual(json(web.myPassSchema));
    expect(json(shared.courierSchema)).toEqual(json(web.courierSchema));
    expect(json(shared.gateLogSchema)).toEqual(json(web.gateLogSchema));
    expect(json(shared.gateLogPageSchema)).toEqual(json(web.gateLogPageSchema));
    expect(json(shared.portalGateOverviewSchema)).toEqual(json(web.portalOverviewSchema));
  });

  it('yardimcilar ayni sonucu verir', () => {
    for (const input of ['34 abc 123', '06ıi1234', '99 Q 1', '', '35-AB-12', '01 A 1234']) {
      expect(shared.normalizePlate(input)).toBe(plate.normalizePlate(input));
      expect(shared.plateError(input)).toBe(plate.plateError(input));
      expect(shared.formatPlate(shared.normalizePlate(input))).toBe(plate.formatPlate(plate.normalizePlate(input)));
    }
    expect(shared.formatShortCode('K7M2PQ4X')).toBe(plate.formatShortCode('K7M2PQ4X'));
    expect(shared.passLink('https://w.test/', 'tok', 'K7M2PQ4X')).toBe(plate.passLink('https://w.test/', 'tok', 'K7M2PQ4X'));
    expect(shared.validityText('2026-11-28', '2026-11-30')).toBe(plate.validityText('2026-11-28', '2026-11-30'));
    expect(shared.VERDICT_TEXT).toEqual(plate.VERDICT_TEXT);
    expect(shared.LOG_KIND_TEXT).toEqual(plate.LOG_KIND_TEXT);
    expect(shared.DIRECTION_TEXT).toEqual(plate.DIRECTION_TEXT);
    const base = { guestName: 'Ayşe', validFrom: '2026-11-28', validUntil: '', today: '2026-11-28', maxPassDays: 31, maxPassLeadDays: 90 };
    for (const f of [base, { ...base, guestName: 'A' }, { ...base, validFrom: '2026-11-27' }, { ...base, validFrom: '2027-03-01' }, { ...base, validUntil: '2026-11-27' }, { ...base, validUntil: '2026-12-29' }]) {
      expect(shared.passFormError(f)).toBe(pass.passFormError(f));
    }
  });
});
