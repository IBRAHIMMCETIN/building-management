import { describe, expect, it } from 'vitest';
import { ApiError } from './errors';
import { formatIndex, itemErrorMessage, parseIndexText } from './meterReadings';
import { checklistErrors, groupMyWork } from './work';

const ticket = (id: string, over: Partial<{ priority: string; dueAt: string; overdue: boolean }> = {}) => ({ ticketId: id, priority: 'normal', dueAt: '2026-11-29T10:00:00Z', overdue: false, ...over });
const task = (id: string, dueDate: string, overdue = false) => ({ taskId: id, dueDate, overdue });

describe('groupMyWork (İşlerim)', () => {
  it('bugun: taleplerim + vadesi gelen bakimlar; hafta: 7 gun; havuz: atanmamislar', () => {
    const g = groupMyWork(
      {
        myTickets: [ticket('t1'), ticket('t2', { priority: 'urgent', dueAt: '2026-12-01T10:00:00Z' })],
        myTasks: [task('m-today', '2026-11-28'), task('m-late', '2026-11-20', true), task('m-week', '2026-12-03'), task('m-far', '2026-12-20')],
        poolTickets: [ticket('p1')],
        poolTasks: [task('pm1', '2026-12-04'), task('pm-far', '2026-12-30')],
      },
      '2026-11-28',
    );
    expect(g.today.map((w) => (w.type === 'ticket' ? w.ticket.ticketId : w.task.taskId))).toEqual(['m-late', 't2', 'm-today', 't1']);
    expect(g.week.map((w) => (w.type === 'task' ? w.task.taskId : ''))).toEqual(['m-week']);
    expect(g.pool.map((w) => (w.type === 'ticket' ? w.ticket.ticketId : w.task.taskId))).toEqual(['p1', 'pm1']);
  });
});

describe('checklistErrors', () => {
  const t = { checklist: [{ id: 'a', text: 'Kabin', required: true }, { id: 'b', text: 'Kapı', required: false }] };
  it('zorunlu madde ve sorunlu madde notu', () => {
    expect(checklistErrors(t, [{ id: 'a', ok: null, note: '' }])).toBe('Zorunlu madde cevaplanmadı: Kabin');
    expect(checklistErrors(t, [{ id: 'a', ok: false, note: 'x' }])).toBe('Başarısız madde için açıklama gerekli: Kabin');
    expect(checklistErrors(t, [{ id: 'a', ok: true, note: '' }, { id: 'b', ok: null, note: '' }])).toBeNull();
  });
});

describe('sayac endeksi', () => {
  it.each([
    ['1234', 0, 1234],
    ['1.234', 0, 1234],
    ['1234,5', 3, 1234500],
    ['1.234,567', 3, 1234567],
    ['12.5', 1, 125],
  ])('%s (olcek %d) -> %d', (text, scale, value) => expect(parseIndexText(text, scale)).toEqual({ ok: true, value }));

  it('hatali girisler Turkce mesajla', () => {
    expect(parseIndexText('', 0)).toEqual({ ok: false, message: 'Endeks boş' });
    expect(parseIndexText('12a', 0).ok).toBe(false);
    expect(parseIndexText('1,25', 0)).toEqual({ ok: false, message: 'Bu sayaç ondalık kabul etmez' });
  });

  it('gosterim ve kalem hatasi', () => {
    expect(formatIndex(1234567, 3)).toBe('1.234,567');
    expect(formatIndex(12, 0)).toBe('12');
    expect(itemErrorMessage(new ApiError(422, { error: 'invalid', items: [{ ref: 0, code: 'below_start', message: 'Endeks son endeksten küçük' }] }))).toBe('Endeks son endeksten küçük');
    expect(itemErrorMessage(new Error('x'))).toBeUndefined();
  });
});
