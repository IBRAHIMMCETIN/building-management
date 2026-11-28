import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import { rateLimitSeconds } from '../api/gate';
import { addDays, courierState, formatPlate, formatShortCode, normalizePlate, parseScan } from './plate';

describe('parseScan (QR / kisa kod)', () => {
  const token = 'aB3_dE5-fG7hJ9kL1mN2pQ4r';

  it('gecis baglantisi, ham jeton ve kisa kod', () => {
    expect(parseScan(`https://app.test/gecis/${token}#K7M2PQ4X`)).toEqual({ token });
    expect(parseScan(`  ${token} `)).toEqual({ token });
    expect(parseScan('k7m2-pq4x')).toEqual({ code: 'K7M2PQ4X' });
  });

  it('tanınmayan metin: undefined', () => {
    expect(parseScan('https://baska.site/x')).toBeUndefined();
    expect(parseScan('K7M2-PQ4')).toBeUndefined();
    expect(parseScan('K7M2-PQ41')).toBeUndefined();
  });

  it('kisa kod gosterimi', () => expect(formatShortCode('K7M2PQ4X')).toBe('K7M2-PQ4X'));
});

describe('plaka', () => {
  it('normalize ve bicim', () => {
    expect(normalizePlate('34 abc-123')).toBe('34ABC123');
    expect(normalizePlate('06 ı 1234')).toBe('06I1234');
    expect(formatPlate('34ABC123')).toBe('34 ABC 123');
    expect(formatPlate('ABC')).toBe('ABC');
  });
});

describe('kurye durumu', () => {
  const base = { status: 'waiting', expired: false };
  it('sunucu alanlarindan ekran durumu', () => {
    expect(courierState(base)).toBe('waiting');
    expect(courierState({ ...base, expired: true })).toBe('expired');
    expect(courierState({ status: 'approved', expired: false, approvalExpired: true })).toBe('approval_expired');
    expect(courierState({ status: 'approved', expired: false, enteredAt: 'x' })).toBe('inside');
    expect(courierState({ status: 'approved', expired: false, enteredAt: 'x', exitedAt: 'y' })).toBe('done');
  });
});

describe('deneme siniri (429)', () => {
  it('govdedeki sure; yoksa 60 sn; 429 disi null', () => {
    expect(rateLimitSeconds(new ApiError(429, { error: 'rate_limited', retryAfterSeconds: 125 }))).toBe(125);
    expect(rateLimitSeconds(new ApiError(429, { error: 'rate_limited', retryAfterSeconds: '30' }))).toBe(30);
    expect(rateLimitSeconds(new ApiError(429, { error: 'rate_limited' }))).toBe(60);
    expect(rateLimitSeconds(new ApiError(409, { error: 'pass_used' }))).toBeNull();
    expect(rateLimitSeconds(new Error('x'))).toBeNull();
  });
});

it('addDays', () => expect(addDays('2026-12-31', 1)).toBe('2027-01-01'));
