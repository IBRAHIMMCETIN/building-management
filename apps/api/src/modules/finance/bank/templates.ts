import { BankError } from './errors.js';
import { AMOUNT_MODES, type AmountMode, BANK_FIELDS, type BankField, type BankFormatSpec } from './types.js';

/*
 * Sutun esleme: baslik metni -> alan. Basliklar "katlanir" (kucuk harf, Turkce karakterler ASCII,
 * bosluk/noktalama yok): "İşlem Tarihi" -> "islemtarihi", "Tutar (TL)" -> "tutartl".
 *
 * Hazir sablonlar takma ad (alias) kumeleridir; banka adina gore ayri sutun sirasi varsayilmaz.
 * Ayni banka farkli kanallardan (bireysel/kurumsal sube, Excel/CSV) farkli basliklar verebildiginden
 * eslesme her dosyada baslik satiri okunarak yapilir. NOT: banka bazli takma adlar gercek ekstre
 * ornekleriyle henuz dogrulanmadi (`verified: false`); ilk kullanimda onizleme kontrol edilmeli,
 * gerekirse hesaba ozel esleme (BANKFMT) kaydedilmelidir.
 */

const ASCII_FOLD: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', i: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };

export function foldHeader(v: string): string {
  return v
    .toLocaleLowerCase('tr-TR')
    .normalize('NFC')
    .replace(/[çğıiöşüâîû]/g, (ch) => ASCII_FOLD[ch] ?? ch)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Alan -> takma adlar (katlanmis). Siralama oncelik sirasidir. */
const GENERIC_ALIASES: Record<BankField, string[]> = {
  date: ['islemtarihi', 'tarih', 'islemzamani', 'tarihsaat', 'islemtarihisaati', 'muhasebetarihi', 'kayittarihi', 'date', 'transactiondate'],
  valueDate: ['valortarihi', 'valor', 'valuedate'],
  description: ['aciklama', 'islemaciklamasi', 'aciklamalar', 'detay', 'islemdetayi', 'aciklamadetay', 'description', 'narrative'],
  amount: ['tutar', 'islemtutari', 'tutartl', 'tutartry', 'miktar', 'amount'],
  debit: ['borc', 'borctutari', 'cikan', 'giden', 'cikis', 'borctl', 'debit'],
  credit: ['alacak', 'alacaktutari', 'giren', 'gelen', 'giris', 'alacaktl', 'credit'],
  direction: ['ba', 'borcalacak', 'islemyonu', 'yon', 'dc'],
  balance: ['bakiye', 'islemsonrasibakiye', 'kalanbakiye', 'bakiyetl', 'guncelbakiye', 'balance'],
  reference: ['dekontno', 'dekontnumarasi', 'referans', 'referansno', 'islemno', 'islemnumarasi', 'fisno', 'islemreferansi', 'reference'],
  counterpartyName: ['gonderen', 'gonderenadi', 'karsitaraf', 'karsitarafadi', 'karsihesapadi', 'aliciadi', 'gonderenalici', 'unvan'],
  counterpartyIban: ['gondereniban', 'karsiiban', 'karsitarafiban', 'karsihesapiban'],
};

export type BankTemplate = {
  id: string;
  name: string;
  /** Banka bazli takma adlar gercek ekstrelerle dogrulandi mi? */
  verified: boolean;
  aliases: Record<BankField, string[]>;
};

const withExtra = (extra: Partial<Record<BankField, string[]>>): Record<BankField, string[]> =>
  Object.fromEntries(BANK_FIELDS.map((f) => [f, [...(extra[f] ?? []), ...GENERIC_ALIASES[f]]])) as Record<BankField, string[]>;

/** Hazir sablonlar. `generic` her bankada once denenir. */
export const BANK_TEMPLATES: readonly BankTemplate[] = [
  { id: 'generic', name: 'Genel (otomatik tespit)', verified: false, aliases: withExtra({}) },
  { id: 'ziraat', name: 'Ziraat Bankası', verified: false, aliases: withExtra({}) },
  { id: 'vakifbank', name: 'VakıfBank', verified: false, aliases: withExtra({}) },
  { id: 'halkbank', name: 'Halkbank', verified: false, aliases: withExtra({}) },
  { id: 'isbank', name: 'Türkiye İş Bankası', verified: false, aliases: withExtra({}) },
  { id: 'garanti', name: 'Garanti BBVA', verified: false, aliases: withExtra({}) },
  { id: 'yapikredi', name: 'Yapı Kredi', verified: false, aliases: withExtra({}) },
  { id: 'akbank', name: 'Akbank', verified: false, aliases: withExtra({}) },
  { id: 'qnb', name: 'QNB', verified: false, aliases: withExtra({}) },
  { id: 'denizbank', name: 'DenizBank', verified: false, aliases: withExtra({}) },
];

export const templateById = (id: string | undefined) => BANK_TEMPLATES.find((t) => t.id === (id ?? 'generic'));

/** Yon sutunu varsayilan degerleri (katlanmis). Musteri gozunden: Borc = cikan, Alacak = giren. */
export const DEFAULT_DIRECTION_VALUES = {
  in: ['a', 'alacak', '+', 'gelen', 'giris', 'giren', 'c', 'cr', 'credit'],
  out: ['b', 'borc', '-', 'giden', 'cikis', 'cikan', 'd', 'dr', 'debit'],
};

// ---------------------------------------------------------------------------
// Baslik satiri tespiti
// ---------------------------------------------------------------------------

export type ResolvedColumns = Partial<Record<BankField, number>>;

export type HeaderMatch = {
  headerRowIndex: number;
  /** Alan -> ORIJINAL baslik metni (kaydedilen esleme bunlarla tutulur). */
  columns: Partial<Record<BankField, string>>;
  indexes: ResolvedColumns;
  amountMode: AmountMode;
};

function matchFields(header: string[], aliases: Record<BankField, string[]>): ResolvedColumns {
  const folded = header.map(foldHeader);
  const used = new Set<number>();
  const out: ResolvedColumns = {};
  for (const field of BANK_FIELDS) {
    for (const alias of aliases[field]) {
      const idx = folded.findIndex((h, i) => h === alias && !used.has(i));
      if (idx >= 0) {
        out[field] = idx;
        used.add(idx);
        break;
      }
    }
  }
  // Ikinci tur: tam eslesmeyenler icin "ile baslar" (ornek "aciklama1", "tutartlkarsiligi").
  for (const field of BANK_FIELDS) {
    if (out[field] !== undefined) continue;
    for (const alias of aliases[field]) {
      if (alias.length < 4) continue;
      const idx = folded.findIndex((h, i) => h.startsWith(alias) && !used.has(i));
      if (idx >= 0) {
        out[field] = idx;
        used.add(idx);
        break;
      }
    }
  }
  // "Valor" hem tarih hem valor olarak eslenmisse tarih alani islem tarihini tercih eder.
  return out;
}

function modeFor(idx: ResolvedColumns): AmountMode | undefined {
  if (idx.debit !== undefined && idx.credit !== undefined) return 'debit_credit';
  if (idx.amount !== undefined && idx.direction !== undefined) return 'amount_direction';
  if (idx.amount !== undefined) return 'signed';
  return undefined;
}

/** Ilk 40 satirda tarih + aciklama + tutar alanlari bulunan en iyi baslik satiri. */
export function detectHeader(rows: string[][], templateId?: string): HeaderMatch | undefined {
  const template = templateById(templateId) ?? templateById('generic');
  if (!template) return undefined;
  let best: (HeaderMatch & { score: number }) | undefined;
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const header = rows[r] ?? [];
    if (header.filter((c) => c.trim()).length < 3) continue;
    const idx = matchFields(header, template.aliases);
    if (idx.date === undefined && idx.valueDate !== undefined) {
      idx.date = idx.valueDate;
      delete idx.valueDate;
    }
    const mode = modeFor(idx);
    if (idx.date === undefined || idx.description === undefined || !mode) continue;
    const score = Object.keys(idx).length;
    if (!best || score > best.score) {
      const columns = Object.fromEntries(Object.entries(idx).map(([f, i]) => [f, header[i as number] ?? ''])) as HeaderMatch['columns'];
      best = { headerRowIndex: r, columns, indexes: idx, amountMode: mode, score };
    }
  }
  if (!best) return undefined;
  const { score: _s, ...match } = best;
  return match;
}

/** Kayitli/istenen eslemeyi dosyaya uygular: baslik metinleri -> sutun indeksleri. */
export function applySpec(rows: string[][], spec: BankFormatSpec): HeaderMatch {
  const wanted = Object.entries(spec.columns).filter(([, h]) => h) as [BankField, string][];
  const candidates = spec.headerRow ? [spec.headerRow - 1] : Array.from({ length: Math.min(rows.length, 40) }, (_, i) => i);
  for (const r of candidates) {
    const folded = (rows[r] ?? []).map(foldHeader);
    const indexes: ResolvedColumns = {};
    let ok = true;
    for (const [field, header] of wanted) {
      const i = folded.indexOf(foldHeader(header));
      if (i < 0) {
        ok = false;
        break;
      }
      indexes[field] = i;
    }
    if (ok) return { headerRowIndex: r, columns: { ...spec.columns }, indexes, amountMode: spec.amountMode };
  }
  throw new BankError('unprocessable', 'Kayitli sutun eslemesi bu dosyanin basliklariyla uyusmuyor; eslemeyi guncelleyin', {
    expectedHeaders: wanted.map(([, h]) => h),
  });
}

// ---------------------------------------------------------------------------
// Esleme dogrulamasi (istek govdesi / PUT formats)
// ---------------------------------------------------------------------------

const REQUIRED: Record<AmountMode, BankField[]> = {
  signed: ['date', 'description', 'amount'],
  debit_credit: ['date', 'description', 'debit', 'credit'],
  amount_direction: ['date', 'description', 'amount', 'direction'],
};

export function validateSpec(raw: unknown): BankFormatSpec {
  const fail = (message: string, field?: string): never => {
    throw new BankError('unprocessable', message, field ? { field } : undefined);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('format bir nesne olmalidir', 'format');
  const o = raw as Record<string, unknown>;
  const amountMode = o.amountMode;
  if (typeof amountMode !== 'string' || !(AMOUNT_MODES as readonly string[]).includes(amountMode)) {
    return fail(`amountMode su degerlerden biri olmalidir: ${AMOUNT_MODES.join(', ')}`, 'amountMode');
  }
  const cols = o.columns;
  if (typeof cols !== 'object' || cols === null || Array.isArray(cols)) return fail('columns bir nesne olmalidir', 'columns');
  const columns: Partial<Record<BankField, string>> = {};
  for (const [k, v] of Object.entries(cols as Record<string, unknown>)) {
    if (!(BANK_FIELDS as readonly string[]).includes(k)) fail(`Bilinmeyen alan: ${k}`, 'columns');
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || v.trim().length < 1 || v.length > 80 || !foldHeader(v)) fail(`columns.${k} gecerli bir baslik olmalidir`, 'columns');
    columns[k as BankField] = (v as string).trim();
  }
  for (const f of REQUIRED[amountMode as AmountMode]) {
    if (!columns[f]) fail(`${amountMode} modunda columns.${f} zorunludur`, 'columns');
  }
  const folded = Object.values(columns).map((h) => foldHeader(h as string));
  if (new Set(folded).size !== folded.length) fail('Ayni baslik birden fazla alana eslenemez', 'columns');

  let headerRow: number | undefined;
  if (o.headerRow !== undefined) {
    if (typeof o.headerRow !== 'number' || !Number.isSafeInteger(o.headerRow) || o.headerRow < 1 || o.headerRow > 40) {
      fail('headerRow 1-40 araliginda tam sayi olmalidir', 'headerRow');
    }
    headerRow = o.headerRow as number;
  }
  let templateId: string | undefined;
  if (o.templateId !== undefined) {
    if (typeof o.templateId !== 'string' || !templateById(o.templateId)) fail('templateId bilinmiyor', 'templateId');
    templateId = o.templateId as string;
  }
  let directionValues: BankFormatSpec['directionValues'];
  if (o.directionValues !== undefined) {
    const dv = o.directionValues as Record<string, unknown>;
    const list = (v: unknown, k: string) => {
      if (!Array.isArray(v) || v.length < 1 || v.length > 10 || !v.every((x) => typeof x === 'string' && x.trim() && x.length <= 20)) {
        fail(`directionValues.${k} 1-10 ogeli metin dizisi olmalidir`, 'directionValues');
      }
      return (v as string[]).map((x) => x.trim());
    };
    directionValues = { in: list(dv?.in, 'in'), out: list(dv?.out, 'out') };
  }
  return {
    amountMode: amountMode as AmountMode,
    columns,
    ...(headerRow ? { headerRow } : {}),
    ...(templateId ? { templateId } : {}),
    ...(directionValues ? { directionValues } : {}),
  };
}
