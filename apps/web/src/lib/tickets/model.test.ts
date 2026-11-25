import { describe, expect, it } from 'vitest';
import { addMonth, monthGrid, monthLabel, scheduleText } from '@/lib/maintenance/schedule';
import { matchesTicket, locationText, noteRequired, photoIdOf, slaText } from './model';
import { groupMyWork } from './myWork';
import { operationsPending } from './pending';

const NOW = new Date('2026-11-25T09:00:00.000Z');

describe('ariza modeli', () => {
  it('SLA metni: kalan / geciken; cozulen talepte yok', () => {
    expect(slaText({ status: 'open', dueAt: '2026-11-25T12:20:00.000Z' }, NOW)).toEqual({ text: '3 sa 20 dk kaldı', overdue: false });
    expect(slaText({ status: 'in_progress', dueAt: '2026-11-23T07:00:00.000Z' }, NOW)).toEqual({ text: '2 gün 2 sa gecikti', overdue: true });
    expect(slaText({ status: 'open', dueAt: '2026-11-25T09:00:30.000Z' }, NOW)?.text).toBe('1 dk kaldı');
    expect(slaText({ status: 'resolved', dueAt: '2026-11-20T00:00:00.000Z' }, NOW)).toBeNull();
  });

  it('not zorunlulugu API kuraliyla ayni; iptal yalnizca yoneticide gerekceli', () => {
    expect(['hold', 'resolve', 'close', 'reopen'].every((a) => noteRequired(a as never, false))).toBe(true);
    expect(noteRequired('start', true)).toBe(false);
    expect(noteRequired('confirm', false)).toBe(false);
    expect(noteRequired('cancel', true)).toBe(true);
    expect(noteRequired('cancel', false)).toBe(false);
  });

  it('fotograf kimligi, konum metni ve arama', () => {
    expect(photoIdOf('apartments/a1/tickets/t1/0123abcd.jpg')).toBe('0123abcd_jpg');
    expect(locationText({ kind: 'unit', unitId: 'u1' }, () => '5')).toBe('Daire 5');
    expect(locationText({ kind: 'unit', unitId: 'u9' })).toBe('Daire u9');
    expect(locationText({ kind: 'common', area: 'Lobi' })).toBe('Ortak alan · Lobi');
    expect(matchesTicket({ number: 'T-000012', title: 'Işık yanmıyor' }, 'ışık')).toBe(true);
    expect(matchesTicket({ number: 'T-000012', title: 'Asansör' }, 't-0000')).toBe(true);
    expect(matchesTicket({ number: 'T-000012', title: 'Asansör' }, 'hidrofor')).toBe(false);
  });
});

describe('bakim takvimi', () => {
  it('siklik metni ve ay gecisleri', () => {
    expect(scheduleText({ every: 1, unit: 'month' })).toBe('Aylık');
    expect(scheduleText({ every: 3, unit: 'month' })).toBe('3 ayda bir');
    expect(scheduleText({ every: 2, unit: 'week' })).toBe('2 haftada bir');
    expect(scheduleText({ every: 1, unit: 'year' })).toBe('Yıllık');
    expect(addMonth('2026-12', 1)).toBe('2027-01');
    expect(addMonth('2026-01', -1)).toBe('2025-12');
    expect(monthLabel('2026-11').toLocaleLowerCase('tr')).toBe('kasım 2026');
  });

  it('ay izgarasi pazartesiyle baslar; ay disi gunler bos', () => {
    const g = monthGrid('2026-11');
    // 1 Kasim 2026 Pazar.
    expect(g[0]).toEqual([null, null, null, null, null, null, '2026-11-01']);
    expect(g.at(-1)).toEqual(['2026-11-30', null, null, null, null, null, null]);
    expect(g.flat().filter(Boolean)).toHaveLength(30);
    expect(monthGrid('2027-02').every((w) => w.length === 7)).toBe(true);
  });
});

describe('gorevli is listesi', () => {
  const tk = (id: string, extra: Partial<{ priority: string; overdue: boolean; dueAt: string }> = {}) => ({ ticketId: id, priority: 'normal', dueAt: '2026-11-27T10:00:00.000Z', overdue: false, ...extra });
  const ts = (id: string, dueDate: string, overdue = false) => ({ taskId: id, dueDate, overdue });

  it('bugun: atanan talepler + vadesi gelen bakimlar (acil / geciken once); bu hafta; havuz', () => {
    const g = groupMyWork(
      {
        myTickets: [tk('t1'), tk('t2', { priority: 'urgent' })],
        myTasks: [ts('m-old', '2026-11-20', true), ts('m-today', '2026-11-25'), ts('m-week', '2026-12-01'), ts('m-later', '2026-12-20')],
        poolTickets: [tk('t3')],
        poolTasks: [ts('p1', '2026-11-26'), ts('p-far', '2027-01-10')],
      },
      '2026-11-25',
    );
    expect(g.today.map((w) => (w.type === 'ticket' ? w.ticket.ticketId : w.task.taskId))).toEqual(['m-old', 't2', 'm-today', 't1']);
    expect(g.week.map((w) => (w.type === 'task' ? w.task.taskId : ''))).toEqual(['m-week']);
    expect(g.pool.map((w) => (w.type === 'ticket' ? w.ticket.ticketId : w.task.taskId))).toEqual(['p1', 't3']);
  });
});

describe('genel bakis bekleyen isler', () => {
  it('yalnizca sifirdan buyuk kalemler, dogru baglantilarla', () => {
    expect(operationsPending({ urgentOpen: 2, slaOverdue: 0, maintenanceOverdue: 1 })).toEqual([
      { code: 'tickets_urgent', message: 'Açık acil arıza talebi', count: 2, to: '/admin/tickets' },
      { code: 'maintenance_overdue', message: 'Geciken periyodik bakım', count: 1, to: '/admin/tickets?tab=calendar' },
    ]);
    expect(operationsPending({})).toEqual([]);
  });
});
