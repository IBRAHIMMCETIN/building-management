import { describe, expect, it } from 'vitest';
import type { AvailabilitySlot } from '@/lib/api/reservations';
import { addClock, addDays, dayLabel, durationOptions, formatMinutes, groupByDate, hoursSummary, istanbulToday, weekOf, weekdayOf } from './model';

const slot = (start: string, end: string, state: AvailabilitySlot['state'] = 'free'): AvailabilitySlot => ({ start, end, startAt: '', state });

describe('rezervasyon modeli: tarih ve saat', () => {
  it('Istanbul gunu, gun ekleme, hafta (Pazartesi-Pazar), hafta gunu', () => {
    // 27.11.2026 23:30 Istanbul = 20:30 UTC; 21:30 UTC ertesi gun.
    expect(istanbulToday(new Date('2026-11-27T20:30:00.000Z'))).toBe('2026-11-27');
    expect(istanbulToday(new Date('2026-11-27T21:30:00.000Z'))).toBe('2026-11-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekdayOf('2026-11-29')).toBe(7);
    expect(weekOf('2026-11-29')).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']);
    expect(weekOf('2026-11-23')[0]).toBe('2026-11-23');
    expect(dayLabel('2026-11-29')).toBe('29 Kasım Pazar');
  });

  it('sure ve saat metinleri', () => {
    expect(formatMinutes(30)).toBe('30 dk');
    expect(formatMinutes(60)).toBe('1 saat');
    expect(formatMinutes(90)).toBe('1 sa 30 dk');
    expect(formatMinutes(240)).toBe('4 saat');
    expect(addClock('09:30', 90)).toBe('11:00');
    expect(addClock('22:00', 120)).toBe('24:00');
  });

  it('acilis saatleri ozeti: ayni pencereli ardisik gunler birlesir', () => {
    const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, open: '09:00', close: '22:00' }));
    expect(hoursSummary([...weekdays, { day: 6, open: '10:00', close: '18:00' }])).toBe('Pzt–Cum 09:00–22:00 · Cmt 10:00–18:00');
    expect(hoursSummary([{ day: 1, open: '09:00', close: '12:00' }, { day: 3, open: '09:00', close: '12:00' }])).toBe('Pzt 09:00–12:00 · Çar 09:00–12:00');
    expect(hoursSummary([])).toBe('Kapalı');
  });
});

describe('rezervasyon modeli: dilim secimi', () => {
  const day = [slot('09:00', '10:00'), slot('10:00', '11:00'), slot('11:00', '12:00', 'busy'), slot('12:00', '13:00'), slot('13:00', '14:00'), slot('14:00', '15:00'), slot('15:00', '16:00')];

  it('ardisik bos dilimler en uzun sureye kadar; dolu dilimde durur', () => {
    expect(durationOptions(day, 0, 60, 180)).toEqual([60, 120]);
    expect(durationOptions(day, 3, 60, 180)).toEqual([60, 120, 180]);
    expect(durationOptions(day, 3, 60, 120)).toEqual([60, 120]);
    expect(durationOptions(day, 2, 60, 180)).toEqual([]);
    expect(durationOptions(day, 6, 60, 180)).toEqual([60]);
  });

  it('bitisik olmayan dilimler (ogle arasi) birlestirilmez; sahibi olunan dilim de secilemez', () => {
    const gap = [slot('09:00', '10:00'), slot('13:00', '14:00')];
    expect(durationOptions(gap, 0, 60, 240)).toEqual([60]);
    expect(durationOptions([slot('09:00', '09:30'), slot('09:30', '10:00', 'mine')], 0, 30, 120)).toEqual([30]);
  });

  it('takvim gruplamasi: her gun ayri, baslangica gore sirali', () => {
    const items = [
      { id: 'b', date: '2026-11-29', start: '2026-11-29T10:00:00.000Z' },
      { id: 'a', date: '2026-11-29', start: '2026-11-29T07:00:00.000Z' },
      { id: 'c', date: '2026-11-30', start: '2026-11-30T07:00:00.000Z' },
    ];
    expect(groupByDate(items, ['2026-11-28', '2026-11-29']).map((g) => [g.date, g.items.map((i) => i.id)])).toEqual([
      ['2026-11-28', []],
      ['2026-11-29', ['a', 'b']],
    ]);
  });
});
