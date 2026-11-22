import { createHash } from 'node:crypto';
import type { IsoDate, LiableParty } from '../../core/types.js';
import { MAX_ALLOCATIONS } from './types.js';

/*
 * Faz B2 - Banka satiri eslestirme oneri motoru (SAF: yan etkisiz, deterministik).
 *
 * Kanitlar ve guven puani:
 *   1. Aciklamada alt carinin odeme referans kodu (BANKREF)          -> 1.00 (kesin)
 *   2. Ogrenilmis gonderen (PAYER#<ibanMac>: bu IBAN daha once ...)   -> 0.90
 *   3. Blok/daire/villa kalibi ("A-12", "A Blok 12", "Villa 12", "D:12") -> 0.60 (yalniz daire no: 0.45 / belirsizse 0.35)
 *      + ad-soyad benzerligi (Turkce karakter normalize)               -> +0.20 / yalniz ad: 0.55
 *   4. Tutar = acik bakiye veya aylik aidatin tam kati (1-12 ay)      -> +0.10
 * Referans kodu disindaki oneriler 0.95'i asmaz: kesinlik yalnizca kodla gelir.
 */

// ---------------------------------------------------------------------------
// Tipler
// ---------------------------------------------------------------------------

export type MatchCandidate = {
  accountId: string;
  unitId: string;
  liableParty: LiableParty;
  /** Blok adi ("A Blok", "Lale"); tek bloklu sitede bos olabilir. */
  blockName?: string;
  /** Daire/villa numarasi ("12", "V-12"). */
  unitNumber: string;
  unitLabel: string;
  /** Bu alt cariden sorumlu kisilerin adlari (uyelik + kisi kaydi). */
  holderNames: string[];
  /** Acik borc (kurus, avans varsa 0). */
  openBalance: number;
  /** Son aidat tahakkuku tutari (kurus). */
  monthlyDues?: number;
  /** Tasinmada acilmis ayrilan cari. */
  former?: boolean;
  /** Cari kapama kilidi: bu tarih ve oncesine kayit yazilamaz. */
  closedThrough?: IsoDate;
};

export type MatchLine = {
  date: IsoDate;
  direction: 'in' | 'out';
  amount: number;
  description: string;
  counterpartyName?: string;
};

export type PayerHint = { accounts: { accountId: string; count: number }[] };

export type SuggestedAllocation = { accountId: string; unitId: string; liableParty: LiableParty; amount: number };

export type SuggestionKind = 'reference' | 'payer' | 'unit' | 'name';

export type Suggestion = {
  kind: SuggestionKind;
  allocations: SuggestedAllocation[];
  /** 0..1, iki ondalik. */
  confidence: number;
  reasons: string[];
};

export type SuggestInput = {
  line: MatchLine;
  candidates: readonly MatchCandidate[];
  /** Odeme referans kodu -> alt cari. */
  refCodes: ReadonlyMap<string, string>;
  payer?: PayerHint;
  limit?: number;
};

const NON_REFERENCE_CAP = 0.95;

// ---------------------------------------------------------------------------
// Metin normalize
// ---------------------------------------------------------------------------

const TR_UPPER: Record<string, string> = { İ: 'I', I: 'I', Ş: 'S', Ğ: 'G', Ü: 'U', Ö: 'O', Ç: 'C', Â: 'A', Î: 'I', Û: 'U' };

/** "Ayşe Yılmaz / A-12" -> "AYSE YILMAZ A 12" (buyuk harf, ASCII, noktalama bosluk). */
export function normalizeText(s: string): string {
  return s
    .toLocaleUpperCase('tr-TR')
    .replace(/[İIŞĞÜÖÇÂÎÛ]/g, (ch) => TR_UPPER[ch] ?? ch)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'HAVALE', 'EFT', 'FAST', 'AIDAT', 'AIDATI', 'ODEME', 'ODEMESI', 'GONDEREN', 'ALICI', 'ACIKLAMA', 'TL', 'TRY', 'KASIM', 'ARALIK',
  'OCAK', 'SUBAT', 'MART', 'NISAN', 'MAYIS', 'HAZIRAN', 'TEMMUZ', 'AGUSTOS', 'EYLUL', 'EKIM', 'BLOK', 'DAIRE', 'VILLA', 'NO',
  'SITE', 'SITESI', 'YONETIM', 'YONETIMI', 'APT', 'APARTMANI', 'IBAN', 'TR', 'REF', 'ISLEM', 'GELEN', 'INTERNET', 'MOBIL', 'SUBE',
]);

const nameTokens = (s: string) => normalizeText(s).split(' ').filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOPWORDS.has(t));

/** Kisi adinin tokenlarinin metinde gecme orani (0..1). Tek tokenli adlar en fazla 0.5. */
export function nameSimilarity(holderName: string, text: string): number {
  const holder = nameTokens(holderName);
  if (holder.length === 0) return 0;
  const inText = new Set(nameTokens(text));
  const hit = holder.filter((t) => inText.has(t)).length;
  const ratio = hit / holder.length;
  return holder.length === 1 ? Math.min(ratio, 0.5) : ratio;
}

// ---------------------------------------------------------------------------
// Odeme referans kodu
// ---------------------------------------------------------------------------

const REF_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // I ve O yok (1 / 0 ile karismasin)
const REF_DIGITS = '23456789'; // 0 ve 1 yok
/** Harf-rakam-harf-rakam-harf-harf ("K7M2QA"): kelime icinde rastlantisal gecmesi zordur. */
const REF_PATTERN = 'LDLDLL';
export const REF_CODE_RE = /^[A-HJ-NP-Z][2-9][A-HJ-NP-Z][2-9][A-HJ-NP-Z]{2}$/;

/**
 * Alt cari icin deterministik kod. Ayni apartmanda cakisma olursa `attempt` arttirilarak yeni kod
 * uretilir (yazim `attribute_not_exists` ile tekildir).
 */
export function refCodeFor(apartmentId: string, accountId: string, attempt = 0): string {
  const h = createHash('sha256').update(`bankref:v1|${apartmentId}|${accountId}|${attempt}`, 'utf8').digest();
  return [...REF_PATTERN]
    .map((kind, i) => {
      const alphabet = kind === 'L' ? REF_LETTERS : REF_DIGITS;
      return alphabet[(h[i] as number) % alphabet.length];
    })
    .join('');
}

/** Aciklamada gecen referans kodlari (bosluk/tire ile bolunmus yazimlar dahil). */
export function findRefCodes(text: string, refCodes: ReadonlyMap<string, string>): string[] {
  const compact = normalizeText(text).replace(/ /g, '');
  const found: { code: string; at: number }[] = [];
  for (const code of refCodes.keys()) {
    const at = compact.indexOf(code);
    if (at >= 0) found.push({ code, at });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.code);
}

// ---------------------------------------------------------------------------
// Blok / daire kaliplari
// ---------------------------------------------------------------------------

/** "A Blok" -> "A", "Lale Bloku" -> "LALE", "1. Blok" -> "1". */
export function blockToken(blockName: string | undefined): string | undefined {
  if (!blockName) return undefined;
  const tokens = normalizeText(blockName).split(' ').filter((t) => t && !/^BLO(K|KU|CK)$/.test(t));
  return tokens[0];
}

/** "12" -> "12", "V-12" -> "12", "A12" -> "12": daire numarasinin sayisal kismi (tek grup). */
export function unitDigits(unitNumber: string): string | undefined {
  const groups = normalizeText(unitNumber).match(/\d+/g);
  return groups && groups.length === 1 ? String(Number(groups[0])) : undefined;
}

export type UnitRef = { block?: string; number: string; strength: 'block_unit' | 'unit_only' };

/** Aciklamadaki blok/daire referanslari. Blok harfi bilinmiyorsa "D 12" daire 12 sayilir. */
export function findUnitRefs(text: string, knownBlocks: ReadonlySet<string>): UnitRef[] {
  const t = ` ${normalizeText(text)} `;
  const refs: UnitRef[] = [];
  const push = (r: UnitRef) => {
    const number = String(Number(r.number));
    if (!refs.some((x) => x.block === r.block && x.number === number)) refs.push({ ...r, number });
  };
  // Bitis boslugu ileriye bakisla (?= ) aranir: ardisik referanslar ("A 12 B 13") birbirini yutmaz.
  for (const m of t.matchAll(/ ([A-Z0-9]{1,12}) BLOK[A-Z]* (?:(?:DAIRE|NO|D|KAPI) )?(?:NO )?(\d{1,4})(?= )/g)) {
    push({ block: m[1], number: m[2] as string, strength: 'block_unit' });
  }
  for (const m of t.matchAll(/ ([A-Z]) ?(\d{1,4})(?= )/g)) {
    const letter = m[1] as string;
    if (knownBlocks.has(letter)) push({ block: letter, number: m[2] as string, strength: 'block_unit' });
    else if (letter === 'D' || letter === 'V') push({ number: m[2] as string, strength: 'unit_only' });
  }
  for (const m of t.matchAll(/ (?:VILLA|DAIRE|DAIRESI|KAPI|BB|BAGIMSIZ BOLUM)(?: NO)? (\d{1,4})(?= )/g)) {
    push({ number: m[1] as string, strength: 'unit_only' });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Dagitim dogrulamasi
// ---------------------------------------------------------------------------

/** Hata mesaji veya null. Satir tutari tam olarak dagitilmali, en fazla 10 alt cari. */
export function validateAllocations(lineAmount: number, allocations: readonly { accountId: string; amount: number }[]): string | null {
  if (allocations.length < 1 || allocations.length > MAX_ALLOCATIONS) return `Satir 1-${MAX_ALLOCATIONS} alt cariye dagitilabilir`;
  const seen = new Set<string>();
  let total = 0;
  for (const a of allocations) {
    if (!Number.isSafeInteger(a.amount) || a.amount < 1) return 'Dagitim tutarlari pozitif kurus olmali';
    if (seen.has(a.accountId)) return 'Ayni alt cari birden fazla kez secilemez';
    seen.add(a.accountId);
    total += a.amount;
  }
  if (total !== lineAmount) return `Dagitim toplami (${total}) satir tutarina (${lineAmount}) esit olmali`;
  return null;
}

/**
 * Tutari hesaplara acik bakiyeleri sirasiyla dagitir; kalan son hesaba yazilir (avans).
 * Sifir payli hesaplar dusurulur.
 */
export function splitByBalances(amount: number, targets: readonly MatchCandidate[]): SuggestedAllocation[] {
  const out: SuggestedAllocation[] = [];
  let left = amount;
  targets.slice(0, MAX_ALLOCATIONS).forEach((c, i, arr) => {
    const share = i === arr.length - 1 ? left : Math.min(left, Math.max(0, c.openBalance));
    if (share > 0) out.push({ accountId: c.accountId, unitId: c.unitId, liableParty: c.liableParty, amount: share });
    left -= share;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Oneriler
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Tutar acik bakiyeye veya aylik aidatin 1-12 katina esit mi? */
export function amountFits(amount: number, c: Pick<MatchCandidate, 'openBalance' | 'monthlyDues'>): 'balance' | 'dues' | undefined {
  if (c.openBalance > 0 && amount === c.openBalance) return 'balance';
  if (c.monthlyDues && c.monthlyDues > 0 && amount % c.monthlyDues === 0 && amount / c.monthlyDues <= 12) return 'dues';
  return undefined;
}

const one = (c: MatchCandidate, amount: number): SuggestedAllocation[] => [
  { accountId: c.accountId, unitId: c.unitId, liableParty: c.liableParty, amount },
];

export function suggestMatches(input: SuggestInput): Suggestion[] {
  const { line, candidates, refCodes, payer } = input;
  const limit = input.limit ?? 5;
  if (line.direction !== 'in' || line.amount <= 0 || candidates.length === 0) return [];

  const byAccount = new Map(candidates.map((c) => [c.accountId, c]));
  const text = `${line.description} ${line.counterpartyName ?? ''}`;
  const nameText = line.counterpartyName || line.description;
  const out: Suggestion[] = [];
  const isClosed = (c: MatchCandidate) => Boolean(c.closedThrough && c.closedThrough >= line.date);

  // 1) Referans kodu: kesin.
  const codes = findRefCodes(text, refCodes);
  const coded = codes.map((code) => byAccount.get(refCodes.get(code) as string)).filter((c): c is MatchCandidate => !!c);
  if (coded.length === 1) {
    const c = coded[0] as MatchCandidate;
    out.push({ kind: 'reference', allocations: one(c, line.amount), confidence: 1, reasons: [`Ödeme referans kodu: ${codes[0]} (${c.unitLabel})`] });
  } else if (coded.length > 1) {
    out.push({
      kind: 'reference',
      allocations: splitByBalances(line.amount, coded),
      confidence: NON_REFERENCE_CAP,
      reasons: [`Birden fazla ödeme referans kodu: ${codes.join(', ')}`, 'Tutar açık bakiyelere sırayla dağıtıldı'],
    });
  }

  // 2) Ogrenilmis gonderen.
  const payerAccounts = (payer?.accounts ?? [])
    .filter((a) => byAccount.has(a.accountId))
    .sort((a, b) => b.count - a.count || a.accountId.localeCompare(b.accountId));
  for (const [i, pa] of payerAccounts.slice(0, 3).entries()) {
    const c = byAccount.get(pa.accountId) as MatchCandidate;
    const fit = amountFits(line.amount, c);
    const reasons = [`Bu IBAN daha önce ${pa.count} kez ${c.unitLabel} ile eşleştirildi`];
    let confidence = i === 0 ? 0.9 : 0.75;
    if (fit) {
      confidence += 0.05;
      reasons.push(fit === 'balance' ? 'Tutar açık bakiyeye eşit' : 'Tutar aylık aidatın tam katı');
    }
    if (isClosed(c)) {
      confidence -= 0.3;
      reasons.push(`Cari ${c.closedThrough} tarihine kadar kapalı`);
    }
    out.push({ kind: 'payer', allocations: one(c, line.amount), confidence: Math.min(confidence, NON_REFERENCE_CAP), reasons });
  }
  if (payerAccounts.length > 1) {
    const targets = payerAccounts.map((p) => byAccount.get(p.accountId) as MatchCandidate);
    const sum = targets.reduce((s, c) => s + Math.max(0, c.openBalance), 0);
    if (sum === line.amount && targets.every((c) => c.openBalance > 0)) {
      out.push({
        kind: 'payer',
        allocations: splitByBalances(line.amount, targets),
        confidence: 0.9,
        reasons: ['Bu IBAN birden fazla alt cariyle eşleşmiş', 'Tutar bu carilerin açık bakiyeleri toplamına eşit'],
      });
    }
  }

  // 3) Blok/daire kalibi + ad benzerligi, 4) tutar.
  const blocks = new Set(candidates.map((c) => blockToken(c.blockName)).filter((b): b is string => !!b));
  const unitRefs = findUnitRefs(text, blocks);
  const unitScore = new Map<string, { score: number; reason: string }>();
  for (const r of unitRefs) {
    const matches = candidates.filter((c) => unitDigits(c.unitNumber) === r.number && (!r.block || blockToken(c.blockName) === r.block));
    const unitIds = new Set(matches.map((c) => c.unitId));
    const score = r.strength === 'block_unit' ? 0.6 : unitIds.size === 1 ? 0.45 : 0.35;
    const reason = r.block ? `Açıklamada blok/daire: ${r.block}-${r.number}` : `Açıklamada daire no: ${r.number}`;
    for (const unitId of unitIds) {
      const prev = unitScore.get(unitId);
      if (!prev || prev.score < score) unitScore.set(unitId, { score, reason });
    }
  }

  const scored: Suggestion[] = [];
  for (const c of candidates) {
    const unit = unitScore.get(c.unitId);
    const nameScore = Math.max(0, ...c.holderNames.map((n) => nameSimilarity(n, nameText)));
    const reasons: string[] = [];
    let confidence = 0;
    if (unit) {
      confidence = unit.score;
      reasons.push(unit.reason);
      if (nameScore >= 0.99) {
        confidence += 0.2;
        reasons.push('Gönderen adı cari sahibiyle eşleşiyor');
      } else if (nameScore >= 0.5) {
        confidence += 0.1;
        reasons.push('Gönderen adı kısmen eşleşiyor');
      }
    } else if (nameScore >= 0.99) {
      confidence = 0.55;
      reasons.push('Gönderen adı cari sahibiyle eşleşiyor');
    } else {
      continue;
    }
    const fit = amountFits(line.amount, c);
    if (fit) {
      confidence += 0.1;
      reasons.push(fit === 'balance' ? 'Tutar açık bakiyeye eşit' : 'Tutar aylık aidatın tam katı');
    }
    // Ayni dairede taraf secimi: borclu ana cari one, ayrilan cari ve kapali cari geriye.
    if (c.openBalance > 0) confidence += 0.02;
    if (c.former && nameScore < 0.99) confidence -= 0.1;
    if (isClosed(c)) {
      confidence -= 0.3;
      reasons.push(`Cari ${c.closedThrough} tarihine kadar kapalı`);
    }
    if (confidence <= 0.2) continue;
    scored.push({ kind: unit ? 'unit' : 'name', allocations: one(c, line.amount), confidence: Math.min(confidence, NON_REFERENCE_CAP), reasons });
  }
  out.push(...scored);

  // Birden fazla daire anilmis ve tutar acik bakiyeler toplamina esitse: bolme onerisi.
  const multiUnits = unitRefs.length > 1 ? [...unitScore.keys()] : [];
  if (multiUnits.length > 1) {
    const targets = multiUnits
      .map((u) => candidates.filter((c) => c.unitId === u && !c.former && c.openBalance > 0).sort((a, b) => b.openBalance - a.openBalance)[0])
      .filter((c): c is MatchCandidate => !!c);
    if (targets.length > 1 && targets.reduce((s, c) => s + c.openBalance, 0) === line.amount) {
      out.push({
        kind: 'unit',
        allocations: splitByBalances(line.amount, targets),
        confidence: 0.7,
        reasons: [`Açıklamada ${targets.length} daire anılıyor`, 'Tutar açık bakiyeler toplamına eşit'],
      });
    }
  }

  // Ayni dagilimi tasiyan onerilerden en gucluyu tut; guvene gore sirala.
  const best = new Map<string, Suggestion>();
  for (const s of out) {
    const key = s.allocations.map((a) => `${a.accountId}:${a.amount}`).sort().join('|');
    const prev = best.get(key);
    if (!prev || prev.confidence < s.confidence) best.set(key, { ...s, confidence: round2(s.confidence) });
  }
  return [...best.values()]
    .sort((a, b) => b.confidence - a.confidence || (a.allocations[0]?.accountId ?? '').localeCompare(b.allocations[0]?.accountId ?? ''))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Faz B3.5: cikan satir -> tedarikci borcu onerisi (toplu otomatik onaya dahil DEGIL)
// ---------------------------------------------------------------------------

export type PayableCandidate = {
  accountId: string;
  name: string;
  /** Acik borc (kurus). 0 ise odeme onerilmez. */
  openBalance: number;
  /** Acik faturalar (tutar ve aciklama/referans). */
  openItems: readonly { amount: number; description: string; reference?: string }[];
};

export type PayableSuggestion = {
  kind: 'payable';
  payableAccountId: string;
  name: string;
  openBalance: number;
  confidence: number;
  reasons: string[];
};

/**
 * Puanlama: ogrenilmis alici IBAN'i 0.85 (ilk hesap) / 0.7; tedarikci adi karsi taraf adinda veya
 * aciklamada (tam 0.7, kismi 0.5); tutar acik borca veya bir acik faturaya esit +0.15, fatura
 * referansi aciklamada +0.1. Tutar acik borcu asiyorsa oneri yapilmaz (fazla odeme reddedilir).
 * Ust sinir 0.95.
 */
export function suggestPayables(input: {
  line: Pick<MatchLine, 'amount' | 'description' | 'counterpartyName'>;
  candidates: readonly PayableCandidate[];
  payee?: { accounts: readonly { accountId: string; count: number }[] };
  limit?: number;
}): PayableSuggestion[] {
  const { line } = input;
  const text = `${line.counterpartyName ?? ''} ${line.description}`;
  const compactText = normalizeText(text).replace(/\s+/g, '');
  const learned = new Map((input.payee?.accounts ?? []).map((a, i) => [a.accountId, i]));
  const out: PayableSuggestion[] = [];
  for (const c of input.candidates) {
    if (c.openBalance <= 0 || line.amount > c.openBalance) continue;
    const reasons: string[] = [];
    let score = 0;
    const rank = learned.get(c.accountId);
    if (rank !== undefined) {
      score = rank === 0 ? 0.85 : 0.7;
      reasons.push('Bu IBAN’a daha önce bu tedarikçiye ödeme yapıldı');
    }
    const sim = nameSimilarity(c.name, text);
    if (sim >= 0.99 && score < 0.7) {
      score = 0.7;
      reasons.push('Tedarikçi adı açıklamada geçiyor');
    } else if (sim >= 0.5 && score < 0.5) {
      score = 0.5;
      reasons.push('Tedarikçi adı kısmen eşleşiyor');
    }
    if (score === 0) continue;
    if (line.amount === c.openBalance) {
      score += 0.15;
      reasons.push('Tutar açık borca eşit');
    } else if (c.openItems.some((i) => i.amount === line.amount)) {
      score += 0.15;
      reasons.push('Tutar açık bir faturaya eşit');
    }
    if (c.openItems.some((i) => i.reference && i.reference.length >= 4 && compactText.includes(normalizeText(i.reference).replace(/\s+/g, '')))) {
      score += 0.1;
      reasons.push('Fatura numarası açıklamada geçiyor');
    }
    out.push({
      kind: 'payable',
      payableAccountId: c.accountId,
      name: c.name,
      openBalance: c.openBalance,
      confidence: Math.round(Math.min(0.95, score) * 100) / 100,
      reasons,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence || b.openBalance - a.openBalance).slice(0, input.limit ?? 5);
}
