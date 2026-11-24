/**
 * Finans 2.3 - Sayac tuketimi: donem parcalarinin (segment) cikarilmasi ve endeks farki.
 *
 * Sayac degisimi / sifirlanmasi (kural 3): eski sayacin parcasi degisim kaydindaki kapanis
 * endeksiyle biter, yeni sayacin parcasi acilis endeksiyle baslar. Dairenin donem tuketimi
 * parcalarin toplamidir: (eskiKapanis - baslangic) + (sonOkuma - yeniAcilis).
 */
import type { IsoDate } from '../../core/types.js';
import {
  type ApprovedReading,
  type ConsumptionHistory,
  type EngineIssue,
  type MeterKind,
  type MeterRecord,
  type MeterSwapRecord,
  type PeriodReading,
  type Rational,
  type Segment,
  type SegmentEndSource,
  type SegmentStartSource,
  MAX_SCALE,
  SPIKE_MULTIPLIER,
} from './types.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Iki takvim tarihi arasindaki gun farki (b - a). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  if (!ISO_DATE.test(a) || !ISO_DATE.test(b)) throw new Error(`Gecersiz tarih: ${a} / ${b}`);
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export function isValidFactor(f: Rational | undefined): boolean {
  if (!f) return true;
  return Number.isSafeInteger(f.num) && Number.isSafeInteger(f.den) && f.num > 0 && f.den > 0;
}

export type ResolveInput = {
  kind: MeterKind;
  period: { startDate: IsoDate; endDate: IsoDate };
  meters: readonly MeterRecord[];
  swaps: readonly MeterSwapRecord[];
  /** meterId -> son onayli, geri alinmamis okuma (MREADH). */
  lastApproved: ReadonlyMap<string, ApprovedReading>;
  /** meterId -> bu donemin okumasi (MREAD). */
  readings: ReadonlyMap<string, PeriodReading>;
  /** meterId -> son donem tuketimleri (yeniden eskiye, en fazla 3). */
  history?: ReadonlyMap<string, readonly ConsumptionHistory[]>;
};

export type ResolveResult = { segments: Segment[]; errors: EngineIssue[]; warnings: EngineIssue[] };

/**
 * Sicil + degisim kayitlari + son onayli okumalar + donem okumalarindan donemin tuketim
 * parcalarini cikarir. Okuma eksik parcada `endIndex` tanimsiz kalir (dagitimda engelleyici).
 */
export function resolveSegments(input: ResolveInput): ResolveResult {
  const { period, kind } = input;
  const errors: EngineIssue[] = [];
  const warnings: EngineIssue[] = [];
  const segments: Segment[] = [];

  const activeSwaps = input.swaps.filter((s) => s.status === 'active');
  const swapOut = new Map<string, MeterSwapRecord>();
  const swapIn = new Map<string, MeterSwapRecord>();
  for (const s of activeSwaps) {
    if (swapOut.has(s.oldMeterId) || swapIn.has(s.newMeterId)) {
      errors.push({ code: 'invalid_chain', meterId: s.oldMeterId, message: `Sayacın birden fazla etkin değişim kaydı var (${s.swapId})` });
      continue;
    }
    swapOut.set(s.oldMeterId, s);
    swapIn.set(s.newMeterId, s);
  }

  const meters = [...input.meters].filter((m) => m.kind === kind).sort((a, b) => a.unitId.localeCompare(b.unitId) || a.meterId.localeCompare(b.meterId));
  for (const m of meters) {
    if (m.installedAt > period.endDate) continue; // donemden sonra takilmis
    const last = input.lastApproved.get(m.meterId);
    if (last && last.date >= period.endDate) {
      errors.push({
        code: 'already_read',
        unitId: m.unitId,
        meterId: m.meterId,
        message: `Sayacın ${last.date} tarihli onaylı okuması var; önce sonraki dönem geri alınmalı`,
      });
      continue;
    }

    // Kapanis: degisim (veya emeklilik) donem sonuna kadar ise parca kapanis endeksiyle biter.
    const out = swapOut.get(m.meterId);
    let closing: { index: number; date: IsoDate; source: SegmentEndSource } | undefined;
    if (out && out.swapDate <= period.endDate) closing = { index: out.oldClosingIndex, date: out.swapDate, source: 'swap_closing' };
    else if (m.retiredAt && m.retiredAt <= period.endDate && m.closingIndex !== undefined) {
      closing = { index: m.closingIndex, date: m.retiredAt, source: 'retire_closing' };
    }
    // Kapanisi onceki bir onayli okumayla zaten sayilmis sayac donemin disindadir.
    if (closing && last && last.date >= closing.date) continue;

    let startIndex: number;
    let startDate: IsoDate;
    let startSource: SegmentStartSource;
    const inSwap = swapIn.get(m.meterId);
    if (last) {
      startIndex = last.index;
      startDate = last.date;
      startSource = 'last_reading';
    } else if (inSwap) {
      startIndex = inSwap.newOpeningIndex;
      startDate = inSwap.swapDate;
      startSource = 'swap_opening';
    } else {
      startIndex = m.openingIndex;
      startDate = m.installedAt;
      startSource = 'opening';
    }

    const reading = input.readings.get(m.meterId);
    const hist = input.history?.get(m.meterId);
    const endDate = closing ? closing.date : period.endDate;
    const seg: Segment = {
      meterId: m.meterId,
      unitId: m.unitId,
      kind: m.kind,
      scale: m.scale,
      factor: m.factor ?? { num: 1, den: 1 },
      ...(m.maxIndex !== undefined ? { maxIndex: m.maxIndex } : {}),
      startIndex,
      startDate,
      startSource,
      endDate,
      days: Math.max(1, daysBetween(startDate, endDate)),
      ...(hist?.length ? { history: [...hist] } : {}),
    };
    if (closing) {
      seg.endIndex = closing.index;
      seg.endSource = closing.source;
      if (reading) {
        warnings.push({
          code: 'reading_ignored_replaced',
          unitId: m.unitId,
          meterId: m.meterId,
          message: 'Değiştirilen sayacın dönem okuması yok sayıldı; kapanış endeksi değişim kaydından alındı',
        });
      }
    } else if (reading) {
      seg.endIndex = reading.endIndex;
      seg.endSource = 'reading';
      if (reading.estimated) seg.estimated = true;
      if (reading.rolloverConfirmed) seg.rolloverConfirmed = true;
    }
    segments.push(seg);
  }
  return { segments, errors, warnings };
}

/**
 * Parcanin endeks farki (olcekli tam sayi). Tur atma yalnizca yonetici onayi (`rolloverConfirmed`)
 * ve tanimli `maxIndex` ile kabul edilir: (maxIndex + 1 - baslangic) + bitis.
 */
export function segmentDelta(seg: Segment): { delta: number; rollover: boolean } | { error: EngineIssue } {
  const base = { unitId: seg.unitId, meterId: seg.meterId };
  if (!Number.isSafeInteger(seg.scale) || seg.scale < 0 || seg.scale > MAX_SCALE) {
    return { error: { ...base, code: 'invalid_scale', message: `Sayaç ölçeği 0-${MAX_SCALE} olmalı` } };
  }
  if (!isIndex(seg.startIndex) || (seg.endIndex !== undefined && !isIndex(seg.endIndex))) {
    return { error: { ...base, code: 'invalid_index', message: 'Endeks negatif olmayan tam sayı olmalı' } };
  }
  if (seg.endIndex === undefined) {
    const suggestedDelta = suggestEstimate(seg.history, seg.days);
    return {
      error: {
        ...base,
        code: 'missing_reading',
        message: 'Dönem okuması eksik',
        ...(suggestedDelta !== undefined
          ? { suggestion: { startIndex: seg.startIndex, suggestedDelta, suggestedEndIndex: seg.startIndex + suggestedDelta } }
          : {}),
      },
    };
  }
  const raw = seg.endIndex - seg.startIndex;
  if (raw >= 0) return { delta: raw, rollover: false };
  if (!seg.rolloverConfirmed) {
    return { error: { ...base, code: 'negative_delta', message: `Son endeks (${seg.endIndex}) başlangıçtan (${seg.startIndex}) küçük; sayaç değişimi veya tur atma işaretlenmeli` } };
  }
  if (seg.maxIndex === undefined || !isIndex(seg.maxIndex) || seg.maxIndex < seg.startIndex) {
    return { error: { ...base, code: 'invalid_rollover', message: 'Tur atma için sayacın en büyük endeksi tanımlı olmalı' } };
  }
  return { delta: seg.maxIndex + 1 - seg.startIndex + seg.endIndex, rollover: true };
}

/**
 * Tahmin onerisi (karar 1): gecmis donemlerin gunluk ortalamasi x gun, yarim yukari yuvarlanir.
 * Gecmis yoksa tanimsiz. Oneri yalnizca yonetici acikca onaylarsa okuma olarak girilir.
 */
export function suggestEstimate(history: readonly ConsumptionHistory[] | undefined, days: number): number | undefined {
  const h = (history ?? []).filter((x) => isIndex(x.delta) && Number.isSafeInteger(x.days) && x.days > 0).slice(0, 3);
  if (h.length === 0 || days <= 0) return undefined;
  const sumDelta = h.reduce((s, x) => s + BigInt(x.delta), 0n);
  const sumDays = h.reduce((s, x) => s + BigInt(x.days), 0n);
  const num = sumDelta * BigInt(days);
  return Number((num * 2n + sumDays) / (2n * sumDays));
}

/** Sicrama: tuketim > 3 x (gecmis gunluk ortalama x gun). Gecmis yoksa veya ortalama 0 ise uyari yok. */
export function isSpike(delta: number, history: readonly ConsumptionHistory[] | undefined, days: number): boolean {
  const expected = suggestEstimate(history, days);
  if (expected === undefined || expected === 0) return false;
  return BigInt(delta) > SPIKE_MULTIPLIER * BigInt(expected);
}
