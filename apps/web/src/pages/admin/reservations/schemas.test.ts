import { describe, expect, it } from 'vitest';
import type { Facility } from '@/lib/api/reservations';
import { facilityDefaults, facilitySchema, maxDurationChoices, toFacilityInput } from './schemas';

const facility: Facility = {
  facilityId: 'fac-1',
  name: 'Toplantı Salonu',
  description: 'Kurallar',
  capacity: 20,
  openingHours: [
    { day: 1, open: '09:00', close: '22:00' },
    { day: 6, open: '10:00', close: '24:00' },
  ],
  slotMinutes: 60,
  maxBookingMinutes: 180,
  advanceDays: 14,
  maxActivePerUnit: 2,
  requiresApproval: true,
  cancelNoticeHours: 12,
  blockIds: ['b1'],
  feeKurus: 15050,
  incomeAccountId: 'inc-1',
  status: 'active',
  version: 3,
  updatedAt: '2026-11-27T07:00:00.000Z',
};

const issues = (v: unknown) => {
  const r = facilitySchema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('ortak alan formu', () => {
  it('duzenleme: alan -> form -> API ayni degerleri uretir (24:00 <-> 00:00, ucret TL)', () => {
    const form = facilityDefaults(facility);
    expect(form.days[5]).toEqual({ enabled: true, open: '10:00', close: '00:00' });
    expect(form.days[1]?.enabled).toBe(false);
    expect(form.fee).toBe('150,50');
    const input = toFacilityInput(facilitySchema.parse(form));
    expect(input).toEqual({
      name: 'Toplantı Salonu',
      description: 'Kurallar',
      capacity: 20,
      openingHours: facility.openingHours,
      slotMinutes: 60,
      maxBookingMinutes: 180,
      advanceDays: 14,
      maxActivePerUnit: 2,
      cancelNoticeHours: 12,
      requiresApproval: true,
      blockIds: ['b1'],
      feeKurus: 15050,
      incomeAccountId: 'inc-1',
    });
  });

  it('yeni alan varsayilanlari gecerli; bos ucret 0, bos alanlar temizlenir', () => {
    const input = toFacilityInput(facilitySchema.parse({ ...facilityDefaults(), name: 'Havuz', incomeAccountId: 'inc-1' }));
    expect(input).toMatchObject({ feeKurus: 0, incomeAccountId: null, description: null, blockIds: null, slotMinutes: 60, maxBookingMinutes: 120 });
    expect(input.openingHours).toHaveLength(7);
  });

  it('API ile ayni kurallar: :00/:30, kapanis > acilis, en az bir gun, en uzun sure kati, tutar', () => {
    const base = { ...facilityDefaults(), name: 'Salon' };
    const day = (open: string, close: string) => [{ enabled: true, open, close }, ...base.days.slice(1)];
    expect(issues(base)).toEqual([]);
    expect(issues({ ...base, days: day('09:15', '12:00') })).toEqual(['days: Pazartesi: saatler :00 veya :30 olmalı']);
    expect(issues({ ...base, days: day('12:00', '09:00') })).toEqual(['days: Pazartesi: kapanış açılıştan sonra olmalı']);
    expect(issues({ ...base, slotMinutes: '120', maxBookingMinutes: '120', days: day('09:00', '10:00') })).toEqual(['days: Pazartesi: açık kalma süresi en az bir dilim olmalı']);
    expect(issues({ ...base, days: base.days.map((d) => ({ ...d, enabled: false })) })).toEqual(['days: En az bir gün açık olmalı']);
    expect(issues({ ...base, slotMinutes: '90', maxBookingMinutes: '120' })).toEqual(['maxBookingMinutes: En uzun süre dilim uzunluğunun katı olmalı']);
    expect(issues({ ...base, fee: '-5' })).toHaveLength(1);
    expect(issues({ ...base, capacity: '0' })).toEqual(['capacity: Kapasite 1–1000 arasında olmalı']);
    expect(issues({ ...base, advanceDays: 'x' })).toHaveLength(2);
  });

  it('en uzun sure secenekleri dilimin katlari, en fazla 12 saat', () => {
    expect(maxDurationChoices(240)).toEqual([240, 480, 720]);
    expect(maxDurationChoices(90).at(-1)).toBe(720);
  });
});
