import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type Kurus,
  type Unit,
  tenthsM2ToM2,
  toKurus,
  toTenthsM2,
} from '../src/modules/core/types.js';

describe('Kurus (branded integer)', () => {
  it('tam sayilari kabul eder (1.500,50 TL -> 150050)', () => {
    expect(toKurus(150050)).toBe(150050);
    expect(toKurus(0)).toBe(0);
    expect(toKurus(1)).toBe(1);
  });

  it('negatif tutari kabul eder (ters kayit / iade)', () => {
    expect(toKurus(-150050)).toBe(-150050);
  });

  it('guvenli tam sayi sinirlarini kabul eder', () => {
    expect(toKurus(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(toKurus(Number.MIN_SAFE_INTEGER)).toBe(Number.MIN_SAFE_INTEGER);
  });

  it.each([
    ['ondalikli', 1.5],
    ['cok kucuk ondalik', 0.1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['MAX_SAFE_INTEGER + 1', Number.MAX_SAFE_INTEGER + 1],
    ['MIN_SAFE_INTEGER - 1', Number.MIN_SAFE_INTEGER - 1],
  ])('%s deger reddedilir', (_label, value) => {
    expect(() => toKurus(value)).toThrow(/tam sayi/);
  });

  it('kayan nokta hatasi sessizce gecmez; TL -> kurus donusumu yuvarlama ister', () => {
    // 19,99 * 100 = 1998.9999999999998
    expect(() => toKurus(19.99 * 100)).toThrow();
    expect(toKurus(Math.round(19.99 * 100))).toBe(1999);
  });

  it('derleme zamaninda duz number ile karismaz', () => {
    expectTypeOf<Kurus>().not.toEqualTypeOf<number>();
    expectTypeOf<Kurus>().toExtend<number>();
  });
});

describe('grossAreaTenthsM2', () => {
  it('m2 degerini 10 ile carpilmis tam sayiya cevirir', () => {
    expect(toTenthsM2(85.5)).toBe(855);
    expect(toTenthsM2(100)).toBe(1000);
    expect(toTenthsM2(0.1)).toBe(1);
  });

  it('1 ondalikli kayan nokta degerlerinde tam sayi uretir', () => {
    // 0.3 * 10 = 3.0000000000000004 gibi sapmalar yuvarlanir
    expect(toTenthsM2(0.3)).toBe(3);
    expect(toTenthsM2(1.1)).toBe(11);
    expect(Number.isInteger(toTenthsM2(120.7))).toBe(true);
  });

  it('en kucuk anlamli deger 0,1 m2; altindaki reddedilir', () => {
    expect(() => toTenthsM2(0.04)).toThrow();
  });

  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], [Number.MAX_VALUE]])(
    'gecersiz m2 reddedilir: %s',
    (value) => {
      expect(() => toTenthsM2(value)).toThrow();
    },
  );

  it('tenthsM2ToM2 geri donusumu yapar (gidis-donus)', () => {
    expect(tenthsM2ToM2(855)).toBe(85.5);
    expect(tenthsM2ToM2(1)).toBe(0.1);
    expect(tenthsM2ToM2(toTenthsM2(142.3))).toBe(142.3);
  });

  it.each([[0], [-5], [85.5], [Number.NaN], [Number.MAX_SAFE_INTEGER + 1]])(
    'tenthsM2ToM2 gecersiz degeri reddeder: %s',
    (value) => {
      expect(() => tenthsM2ToM2(value)).toThrow(/grossAreaTenthsM2/);
    },
  );

  it('Unit tipinde alan number olarak tanimlidir', () => {
    expectTypeOf<Unit['grossAreaTenthsM2']>().toEqualTypeOf<number>();
  });
});
