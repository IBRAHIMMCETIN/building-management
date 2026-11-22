import { createHash } from 'node:crypto';
import type { IsoDate } from '../../core/types.js';
import { parseDate, parseSignedKurus } from '../../imports/parse.js';
import { extractIban, maskIban } from './iban.js';
import type { Sheet } from './sheet.js';
import { DEFAULT_DIRECTION_VALUES, type HeaderMatch, foldHeader } from './templates.js';
import { FINGERPRINT_VERSION, type LineDirection } from './types.js';

/*
 * Ekstre satirlari -> banka hareketleri (saf). Hucre yorumlama mevcut aktarim ayristiricisini
 * (imports/parse.ts: Turkce tutar ve tarih yazimlari, Excel seri tarihleri) yeniden kullanir.
 */

export const MAX_AMOUNT_KURUS = 99_999_999_999;
const DESCRIPTION_MAX = 500;
const NAME_MAX = 140;
const REFERENCE_MAX = 64;

export type LineError = { row: number; field: string; message: string };

/** Ayristirilmis hareket. `counterpartyIban` YALNIZCA bellekte (ozet uretmek icin) tutulur. */
export type ParsedLine = {
  /** Kaynak dosyadaki satir no (1 tabanli). */
  sourceRow: number;
  date: IsoDate;
  valueDate?: IsoDate;
  direction: LineDirection;
  amount: number;
  balanceAfter?: number;
  description: string;
  counterpartyName?: string;
  counterpartyIban?: string;
  counterpartyIbanMasked?: string;
  bankReference?: string;
};

export type ParseResult = { lines: ParsedLine[]; errors: LineError[]; ignoredRows: number };

// ---------------------------------------------------------------------------
// Hucre yorumlayicilar
// ---------------------------------------------------------------------------

const clean = (v: string | undefined) => (v ?? '').replace(/\s+/g, ' ').trim();

/**
 * Tarih (+ opsiyonel saat). "05.11.2026 14:32", "05/11/2026-14:32:11", "2026-11-05T10:00",
 * Excel seri tarihi (46023 / 46023,58) ve imports/parse.ts'in kabul ettigi tum yazimlar.
 */
export function parseBankDate(cell: string | undefined, numeric = false): IsoDate | null | undefined {
  let t = clean(cell);
  if (!t) return undefined;
  if (numeric && /^\d{5}(\.\d+)?$/.test(t)) return parseDate(t);
  const withTime = /^(\d{1,2}[./-]\d{1,2}[./-]\d{4})[\sT-]+\d{1,2}[:.]\d{2}(?:[:.]\d{2})?$/.exec(t);
  if (withTime) t = withTime[1] as string;
  return parseDate(t);
}

export type AmountCell = { kurus: number; hint?: LineDirection };

/**
 * Makine sayisi -> kurus, ONDALIK metin uzerinden yarim yukari yuvarlama (n*100 kayan nokta
 * carpimi kullanilmaz: 12.345 * 100 = 1234.4999...). 15 anlamli hane Excel'in hassasiyetidir.
 */
function machineKurus(t: string): number | null {
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(n.toPrecision(15).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
  if (!m) return null; // 1e21 ustu: makul tutar degil
  const frac = (m[3] ?? '').padEnd(3, '0');
  let kurus = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) kurus += 1;
  if (!Number.isSafeInteger(kurus)) return null;
  return m[1] === '-' ? -kurus : kurus;
}

/**
 * Isaretli tutar (kurus). Ek bicimler: "+1.500,50", "1.500,50-", "1.500,50 TL", "1.500,50 B" /
 * "1.500,50 A" (yon soneki), Excel makine sayisi ("1500.4999999999998" -> 150050).
 * Bos -> undefined, gecersiz -> null.
 */
export function parseBankAmount(cell: string | undefined, numeric = false): AmountCell | null | undefined {
  let t = clean(cell);
  if (!t) return undefined;
  // Makine sayisi: XLSX sayi hucresi veya kayan nokta artigi ("1500.4999999999998", "1.5E3").
  // "1.500" (3 hane) Turkce binlik yazimdir; bu yola girmez.
  if (numeric || /^-?\d+\.\d{4,}$|^-?\d+(\.\d+)?e[+-]?\d+$/i.test(t)) {
    const kurus = machineKurus(t);
    return kurus !== null && Math.abs(kurus) <= MAX_AMOUNT_KURUS ? { kurus } : null;
  }
  let hint: LineDirection | undefined;
  const suffix = /^(.*?)\s*\(?\b([BA])\)?$/i.exec(t);
  if (suffix && /\d/.test(suffix[1] ?? '')) {
    hint = (suffix[2] ?? '').toUpperCase() === 'A' ? 'in' : 'out';
    t = suffix[1] as string;
  }
  t = t.replace(/\s*(TL|TRY|₺)\s*/gi, '').trim();
  if (t.startsWith('+')) t = t.slice(1);
  let negative = false;
  if (/^[\d.,]+-$/.test(t)) {
    negative = true;
    t = t.slice(0, -1);
  }
  const k = parseSignedKurus(t);
  if (k === null || Math.abs(k) > MAX_AMOUNT_KURUS) return null;
  return { kurus: negative ? -Math.abs(k) : k, ...(hint ? { hint } : {}) };
}

function directionOf(value: string, spec: { in: string[]; out: string[] }): LineDirection | undefined {
  const f = foldHeader(value) || value.trim();
  if (spec.in.map((x) => foldHeader(x) || x.trim()).includes(f)) return 'in';
  if (spec.out.map((x) => foldHeader(x) || x.trim()).includes(f)) return 'out';
  return undefined;
}

// ---------------------------------------------------------------------------
// Satir ayristirma
// ---------------------------------------------------------------------------

export function parseLines(
  sheet: Sheet,
  match: HeaderMatch,
  options: { directionValues?: { in: string[]; out: string[] }; maxLines: number },
): ParseResult {
  const { indexes: ix, amountMode } = match;
  const lines: ParsedLine[] = [];
  const errors: LineError[] = [];
  let ignoredRows = 0;
  const dirValues = options.directionValues ?? DEFAULT_DIRECTION_VALUES;
  const isNum = (r: number, c: number | undefined) => c !== undefined && Boolean(sheet.numeric?.has(`${r}:${c}`));
  const cell = (row: string[], c: number | undefined) => (c === undefined ? '' : (row[c] ?? ''));

  for (let r = match.headerRowIndex + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? [];
    const sourceRow = r + 1;
    if (!row.some((c) => c.trim())) continue;
    const rowErrors: LineError[] = [];
    const err = (field: string, message: string) => rowErrors.push({ row: sourceRow, field, message });

    const date = parseBankDate(cell(row, ix.date), isNum(r, ix.date));
    if (date === undefined) {
      // Toplam / devir / bilgi satirlari: tarih hucresi bos.
      ignoredRows++;
      continue;
    }
    if (date === null) err('date', `Tarih okunamadi: "${clean(cell(row, ix.date)).slice(0, 40)}"`);
    let valueDate: IsoDate | undefined;
    if (ix.valueDate !== undefined) {
      const v = parseBankDate(cell(row, ix.valueDate), isNum(r, ix.valueDate));
      if (v === null) err('valueDate', 'Valor tarihi okunamadi');
      else valueDate = v;
    }

    let direction: LineDirection | undefined;
    let amount = 0;
    if (amountMode === 'debit_credit') {
      const d = parseBankAmount(cell(row, ix.debit), isNum(r, ix.debit));
      const c = parseBankAmount(cell(row, ix.credit), isNum(r, ix.credit));
      if (d === null) err('debit', 'Borc tutari okunamadi');
      if (c === null) err('credit', 'Alacak tutari okunamadi');
      const dk = Math.abs(d?.kurus ?? 0);
      const ck = Math.abs(c?.kurus ?? 0);
      if (dk > 0 && ck > 0) err('amount', 'Ayni satirda hem borc hem alacak tutari var');
      else if (dk > 0) {
        direction = 'out';
        amount = dk;
      } else if (ck > 0) {
        direction = 'in';
        amount = ck;
      }
    } else {
      const a = parseBankAmount(cell(row, ix.amount), isNum(r, ix.amount));
      if (a === null) err('amount', `Tutar okunamadi: "${clean(cell(row, ix.amount)).slice(0, 40)}"`);
      else if (a && a.kurus !== 0) {
        amount = Math.abs(a.kurus);
        if (amountMode === 'amount_direction') {
          const raw = clean(cell(row, ix.direction));
          direction = directionOf(raw, dirValues);
          if (!direction) err('direction', `Islem yonu tanınmadi: "${raw.slice(0, 20)}"`);
        } else {
          direction = a.hint ?? (a.kurus < 0 ? 'out' : 'in');
        }
      }
    }

    let balanceAfter: number | undefined;
    if (ix.balance !== undefined) {
      const b = parseBankAmount(cell(row, ix.balance), isNum(r, ix.balance));
      if (b === null) err('balance', 'Bakiye okunamadi');
      else if (b) balanceAfter = b.hint === 'out' ? -Math.abs(b.kurus) : b.kurus;
    }

    if (rowErrors.length) {
      errors.push(...rowErrors);
      continue;
    }
    if (!direction || amount === 0) {
      // Sifir tutarli bilgi satiri (ornek "Devreden bakiye").
      ignoredRows++;
      continue;
    }

    const desc = extractIban(clean(cell(row, ix.description)));
    const name = ix.counterpartyName !== undefined ? extractIban(clean(cell(row, ix.counterpartyName))) : undefined;
    const ibanCell = ix.counterpartyIban !== undefined ? extractIban(clean(cell(row, ix.counterpartyIban))) : undefined;
    const ref = ix.reference !== undefined ? extractIban(clean(cell(row, ix.reference))).text : '';
    const iban = ibanCell?.iban ?? desc.iban ?? name?.iban;

    lines.push({
      sourceRow,
      date: date as IsoDate,
      ...(valueDate ? { valueDate } : {}),
      direction,
      amount,
      ...(balanceAfter !== undefined ? { balanceAfter } : {}),
      description: desc.text.slice(0, DESCRIPTION_MAX),
      ...(name?.text ? { counterpartyName: name.text.slice(0, NAME_MAX) } : {}),
      ...(iban ? { counterpartyIban: iban, counterpartyIbanMasked: maskIban(iban) } : {}),
      ...(ref ? { bankReference: ref.slice(0, REFERENCE_MAX) } : {}),
    });
    if (lines.length > options.maxLines) break;
  }
  return { lines, errors, ignoredRows };
}

// ---------------------------------------------------------------------------
// Parmak izi
// ---------------------------------------------------------------------------

const normText = (s: string | undefined) => (s ?? '').toLocaleLowerCase('tr-TR').normalize('NFC').replace(/\s+/g, ' ').trim();

export type FingerprintedLine = ParsedLine & {
  fingerprint: string;
  weak: boolean;
  /** Ayni dosyada ayni (guclu) parmak izine sahip onceki satir varsa: tekrar, aktarilmaz. */
  duplicateInFile: boolean;
};

/**
 * Deterministik parmak izi: sha256(surum | hesap | tarih | yon | tutar | bakiye | referans |
 * aciklama) ilk 96 bit (24 hex). Ayni hareket farkli ekstrelerde (cakisan donemler) ayni izi verir.
 *
 * Zayif satir (bakiye VE referans yok): ayni gun ayni tutar/aciklamali iki gercek hareket
 * ayirt edilemez. Bu durumda dosya icindeki gorulme sirasi (`#1`, `#2`, ...) ize eklenir: ayni gunu
 * tam iceren iki ekstrede ayni sira olusur. Yarim gun iceren ekstrelerde yanlis eslesme olabilir;
 * servis cakisan donem uyarisi uretir.
 *
 * Guclu satirlarda (bakiye veya referans var) ayni iz ikinci kez gelirse satir dosya ici tekrardir.
 */
export function fingerprintLines(bankAccountId: string, lines: ParsedLine[]): FingerprintedLine[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const weak = l.balanceAfter === undefined && !l.bankReference;
    const base = [
      `v${FINGERPRINT_VERSION}`,
      bankAccountId,
      l.date,
      l.direction,
      String(l.amount),
      l.balanceAfter === undefined ? '' : String(l.balanceAfter),
      normText(l.bankReference),
      normText(l.description),
    ].join('\u001f');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const input = weak && n > 0 ? `${base}\u001f#${n}` : base;
    const fingerprint = createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 24);
    return { ...l, fingerprint, weak, duplicateInFile: !weak && n > 0 };
  });
}

// ---------------------------------------------------------------------------
// Bakiye surekliligi
// ---------------------------------------------------------------------------

export type BalanceCheck = {
  /** Dosyadaki siralama: eskiden yeniye (asc) veya yeniden eskiye (desc). */
  order: 'asc' | 'desc';
  /** Bakiyesi onceki hareketle tutmayan satirlarin dizideki indeksleri. */
  mismatches: Set<number>;
  openingBalance?: number;
  closingBalance?: number;
};

const signed = (l: ParsedLine) => (l.direction === 'in' ? l.amount : -l.amount);

/**
 * Ardisik iki satirda bakiye(onceki) + tutar(sonraki) = bakiye(sonraki) kontrolu. Dosyanin
 * siralamasi (eskiden yeniye / yeniden eskiye) hangi yonde daha cok kontrol tutuyorsa odur; esitlikte
 * tarih sirasina bakilir.
 */
export function checkBalances(lines: ParsedLine[]): BalanceCheck {
  let asc = 0;
  let desc = 0;
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i - 1] as ParsedLine;
    const c = lines[i] as ParsedLine;
    if (p.balanceAfter === undefined || c.balanceAfter === undefined) continue;
    if (p.balanceAfter + signed(c) === c.balanceAfter) asc++;
    if (c.balanceAfter + signed(p) === p.balanceAfter) desc++;
  }
  const first = lines[0]?.date ?? '';
  const last = lines[lines.length - 1]?.date ?? '';
  const order: 'asc' | 'desc' = desc > asc || (desc === asc && first > last) ? 'desc' : 'asc';

  const mismatches = new Set<number>();
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i - 1] as ParsedLine;
    const c = lines[i] as ParsedLine;
    if (p.balanceAfter === undefined || c.balanceAfter === undefined) continue;
    const ok = order === 'asc' ? p.balanceAfter + signed(c) === c.balanceAfter : c.balanceAfter + signed(p) === p.balanceAfter;
    if (!ok) mismatches.add(order === 'asc' ? i : i - 1);
  }

  const chrono = order === 'asc' ? lines : [...lines].reverse();
  const firstWithBalance = chrono.find((l) => l.balanceAfter !== undefined);
  const lastWithBalance = [...chrono].reverse().find((l) => l.balanceAfter !== undefined);
  return {
    order,
    mismatches,
    ...(firstWithBalance ? { openingBalance: (firstWithBalance.balanceAfter as number) - signed(firstWithBalance) } : {}),
    ...(lastWithBalance ? { closingBalance: lastWithBalance.balanceAfter as number } : {}),
  };
}
