import { describe, expect, it } from 'vitest';
import type { ApartmentRoleView } from '@/lib/api/apartmentRoles';
import { canManageRecord, endReasonError, inviteErrors, isLastManager, teamStatus } from './model';

const T = '2026-11-25';
const r = (userId: string, role: string, over: Partial<ApartmentRoleView> = {}): ApartmentRoleView => ({ userId, role, status: 'active', startDate: '2026-01-01', ...over });

describe('ekip modeli', () => {
  it('durum: aktif / baslayacak / bitis planli / sona erdi', () => {
    expect(teamStatus(r('a', 'observer'), T)).toBe('current');
    expect(teamStatus(r('a', 'observer', { startDate: '2026-12-01' }), T)).toBe('scheduled');
    expect(teamStatus(r('a', 'observer', { endDate: '2026-11-30' }), T)).toBe('ending');
    expect(teamStatus(r('a', 'observer', { endDate: '2026-11-24' }), T)).toBe('ended');
    expect(teamStatus(r('a', 'observer', { status: 'inactive' }), T)).toBe('ended');
  });

  it('yetki: rol hiyerarsisi ve kendi kaydi', () => {
    expect(canManageRecord({ role: 'apartment_manager', userId: 'm' }, r('s', 'building_staff'))).toBe(true);
    expect(canManageRecord({ role: 'apartment_manager', userId: 'm' }, r('c', 'management_company'))).toBe(false);
    expect(canManageRecord({ role: 'management_company', userId: 'c' }, r('c2', 'management_company'))).toBe(true);
    expect(canManageRecord({ role: 'apartment_manager', userId: 'm' }, r('m', 'apartment_manager'))).toBe(false);
    expect(canManageRecord({ role: 'observer', userId: 'o' }, r('s', 'building_staff'))).toBe(false);
  });

  it('son yonetici tahmini', () => {
    const one = [r('m1', 'apartment_manager'), r('s', 'building_staff')];
    expect(isLastManager(one, one[0]!, T)).toBe(true);
    expect(isLastManager(one, one[1]!, T)).toBe(false);
    const ending = [r('m1', 'apartment_manager'), r('m2', 'apartment_manager', { endDate: T })];
    expect(isLastManager(ending, ending[0]!, T)).toBe(true);
    const company = [r('m1', 'apartment_manager'), r('c', 'management_company')];
    expect(isLastManager(company, company[0]!, T)).toBe(false);
  });

  it('form dogrulama', () => {
    expect(inviteErrors({ fullName: 'A', email: 'x', role: '', startDate: '', endDate: '' })).toEqual({
      fullName: expect.any(String),
      email: expect.any(String),
      role: expect.any(String),
      startDate: expect.any(String),
    });
    expect(inviteErrors({ fullName: 'Ali Veli', email: 'ali@x.com', role: 'observer', startDate: T, endDate: '2026-11-01' })).toEqual({ endDate: expect.any(String) });
    expect(inviteErrors({ fullName: 'Ali Veli', email: 'ali@x.com', role: 'observer', startDate: T, endDate: '' })).toEqual({});
    expect(endReasonError('kısa')).toBeDefined();
    expect(endReasonError('Görev süresi doldu')).toBeUndefined();
  });
});
