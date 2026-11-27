import { describe, expect, it } from 'vitest';
import { formatSignedTRY, formatTRY, kurusToInput, parseTRYToKurus } from './money';

describe('parseTRYToKurus', () => {
  it.each([
    ['1.500,50', 150050],
    ['1500,5', 150050],
    ['1500.50', 150050],
    ['1500.5', 150050],
    ['1.500', 150000],
    ['1.500.000', 150000000],
    ['₺ 1 500,00', 150000],
    ['0,01', 1],
    ['12', 1200],
    ['0,1', 10],
  ])('%s -> %i', (input, expected) => {
    expect(parseTRYToKurus(input)).toBe(expected);
  });

  it.each(['', 'abc', '0', '0,00', '-5', '1,234,5', '1,234', '15.00.0', '1,505', '12.5.0', '1000000000,00'])('%s gecersiz', (input) => {
    expect(parseTRYToKurus(input)).toBeNull();
  });

  it('allowZero: sifir kabul edilir, diger kurallar ayni; varsayilan davranis degismez', () => {
    expect(parseTRYToKurus('0', { allowZero: true })).toBe(0);
    expect(parseTRYToKurus('0,00', { allowZero: true })).toBe(0);
    expect(parseTRYToKurus('1.250,50', { allowZero: true })).toBe(125050);
    expect(parseTRYToKurus('-5', { allowZero: true })).toBeNull();
    expect(parseTRYToKurus('', { allowZero: true })).toBeNull();
    expect(parseTRYToKurus('0')).toBeNull();
  });

  it('kayan nokta hatasi yok (0,29 * 100)', () => {
    expect(parseTRYToKurus('0,29')).toBe(29);
    expect(parseTRYToKurus('1.000.000,07')).toBe(100000007);
  });
});

describe('bicimlendirme', () => {
  it('TRY', () => {
    expect(formatTRY(150050).replace(/\s/g, ' ')).toBe('₺1.500,50');
    expect(formatSignedTRY(-30000).startsWith('−')).toBe(true);
    expect(formatSignedTRY(100)).toMatch(/^\+/);
    expect(kurusToInput(150005)).toBe('1500,05');
  });
});
