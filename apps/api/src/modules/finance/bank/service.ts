import { createHash, randomUUID } from 'node:crypto';
import type { Role } from '../../../auth/claims.js';
import { DataAccessError } from '../../../config/dynamodb.js';
import type { AuditDraft } from '../../audit/log.js';
import type { IsoDate, Kurus } from '../../core/types.js';
import { ID_PATTERN, isIsoDate } from '../../core/validation.js';
import { safeFileName } from '../../documents/keys.js';
import { type FinanceRepository, financeRepository } from '../repository.js';
import { BankError } from './errors.js';
import { type IbanMacer, extractIban, loadIbanMacer, macAll } from './iban.js';
import {
  LINES_PAGE_MAX,
  MAX_FILE_BYTES,
  MAX_LINES,
  bankKeys,
  isStatementId,
  isUploadContentType,
  istanbulDate,
  lineIdOf,
  statementFileKey,
} from './keys.js';
import { type FingerprintedLine, type LineError, checkBalances, fingerprintLines, parseLines } from './parse.js';
import { type BankRepository, bankRepository } from './repository.js';
import { readSheet } from './sheet.js';
import { type BankFileStore, UPLOAD_URL_TTL_SECONDS, createBankFileStoreFromEnv } from './store.js';
import { BANK_TEMPLATES, type HeaderMatch, applySpec, detectHeader, validateSpec } from './templates.js';
import {
  type BankFileLock,
  type BankFormat,
  type BankFormatSpec,
  type BankLine,
  type BankStatement,
  FINGERPRINT_VERSION,
  type FormatSource,
  type LineStatus,
  type StatementIssues,
} from './types.js';

/*
 * Faz B1 - Banka ekstresi aktarimi.
 *
 *   1) upload-url : kisa omurlu imzali PUT (S3 apartments/{apt}/bank-statements/{yyyy}/{mm}/{statementId})
 *   2) preview    : dosya S3'ten okunur -> sutun esleme (istek > hesaba kayitli > otomatik) -> satirlar,
 *                   parmak izi, dosya ici / onceden aktarilmis tekrarlar, bakiye surekliligi, cakisan
 *                   donemler. BANKSTMT (previewed) + BANKFILE kilidi atomik yazilir. Tekrar cagrilabilir
 *                   (farkli esleme ile yeniden onizleme).
 *   3) commit     : onizlenen surum ve (varsa) uyarilarin onayi istenir; dosya yeniden okunup ozeti
 *                   dogrulanir, ayni esleme ile ayni satirlar uretilir; yalnizca olmayan BANKTX satirlari
 *                   yazilir (idempotent, yarida kalirsa devam eder); ekstre `committed` + denetim kaydi.
 *
 * Banka satiri defter kaydi degildir: tahsilata cevirme (eslestirme) B2'dedir.
 */

export type BankContext = { apartmentId: string; userId: string; role: Role };

export type BankServiceDeps = {
  repo: BankRepository;
  /** Yoksa (DOCUMENTS_BUCKET tanimsiz) yukleme/onizleme/aktarim 503 doner. */
  store: BankFileStore | undefined;
  /** Yoksa (production'da BANK_IBAN_MAC_KEY_ID tanimsiz) aktarim 503 doner. */
  macer: IbanMacer | undefined;
  accounts: Pick<FinanceRepository, 'getAccount'>;
  now: () => Date;
  newId: () => string;
};

export type PreviewLineFlag = 'duplicate_in_file' | 'duplicate_existing' | 'balance_mismatch' | 'weak_fingerprint';

export type PreviewLine = {
  lineId: string;
  sourceRow: number;
  date: IsoDate;
  valueDate?: IsoDate;
  direction: 'in' | 'out';
  amount: number;
  balanceAfter?: number;
  description: string;
  counterpartyName?: string;
  counterpartyIbanMasked?: string;
  bankReference?: string;
  flags: PreviewLineFlag[];
};

const LINE_STATUSES: readonly LineStatus[] = ['unmatched', 'matched', 'ignored'];

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Yanit gorunumu: ic anahtarlar ve S3 yolu verilmez. */
function publicStatement(s: BankStatement) {
  const { PK: _pk, SK: _sk, fileKey: _key, ...rest } = s;
  return rest;
}

/** Yanit gorunumu: IBAN ozeti istemciye verilmez. */
export function publicLine(l: BankLine) {
  const { PK: _pk, SK: _sk, counterpartyIbanMac: _mac, ...rest } = l;
  return rest;
}

type Analysis = {
  spec: BankFormatSpec;
  formatSource: FormatSource;
  header: HeaderMatch;
  sourceFormat: BankStatement['sourceFormat'];
  lines: FingerprintedLine[];
  errors: LineError[];
  ignoredRows: number;
  mismatchRows: Set<number>;
  openingBalance?: number;
  closingBalance?: number;
};

export function createBankService(overrides: Partial<BankServiceDeps> = {}) {
  const deps: BankServiceDeps = {
    repo: bankRepository,
    accounts: financeRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
    store: 'store' in overrides ? overrides.store : createBankFileStoreFromEnv(),
    macer: 'macer' in overrides ? overrides.macer : loadIbanMacer(),
  };

  const fail = (message: string, field?: string): never => {
    throw new BankError('unprocessable', message, field ? { field } : undefined);
  };

  function requireStore(): BankFileStore {
    if (!deps.store) throw new BankError('unavailable', 'Belge deposu yapilandirilmamis (DOCUMENTS_BUCKET)');
    return deps.store;
  }

  function requireMacer(): IbanMacer {
    if (!deps.macer) throw new BankError('unavailable', 'IBAN ozet anahtari yapilandirilmamis (BANK_IBAN_MAC_KEY_ID)');
    return deps.macer;
  }

  const asObj = (v: unknown): Record<string, unknown> => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) fail('Govde bir nesne olmalidir');
    return v as Record<string, unknown>;
  };

  async function requireBankAccount(apartmentId: string, raw: unknown): Promise<string> {
    if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) fail('bankAccountId gecersiz', 'bankAccountId');
    const id = raw as string;
    const acct = await deps.accounts.getAccount(apartmentId, id);
    if (!acct || acct.type !== 'bank' || acct.status !== 'active') fail('Aktif bir banka hesabi secilmelidir', 'bankAccountId');
    return id;
  }

  function readFileName(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 255) fail('fileName 1-255 karakter olmalidir', 'fileName');
    return safeFileName(raw as string, 'ekstre');
  }

  // -------------------------------------------------------------------------
  // Analiz (onizleme ve aktarimda AYNI kod yolu)
  // -------------------------------------------------------------------------

  async function analyze(ctx: BankContext, bankAccountId: string, bytes: Uint8Array, requested?: BankFormatSpec): Promise<Analysis> {
    const sheet = readSheet(bytes);
    let spec: BankFormatSpec;
    let formatSource: FormatSource;
    let header: HeaderMatch;
    const saved = requested ? undefined : await deps.repo.getFormat(ctx.apartmentId, bankAccountId);
    if (requested) {
      spec = requested;
      formatSource = 'request';
      header = applySpec(sheet.rows, spec);
    } else if (saved) {
      spec = saved.spec;
      formatSource = 'saved';
      header = applySpec(sheet.rows, spec);
    } else {
      const detected = detectHeader(sheet.rows);
      if (!detected) {
        throw new BankError('unprocessable', 'Baslik satiri bulunamadi: tarih, aciklama ve tutar (veya borc/alacak) sutunlari taninmadi. Sutun eslemesini elle verin', {
          // Ilk satirlar (IBAN'lar maskeli) web'de esleme ekrani icin.
          sampleRows: sheet.rows.slice(0, 15).map((r) => r.map((c) => extractIban(c).text.slice(0, 80))),
        });
      }
      header = detected;
      spec = { templateId: 'generic', headerRow: detected.headerRowIndex + 1, columns: detected.columns, amountMode: detected.amountMode };
      formatSource = 'detected';
    }

    const parsed = parseLines(sheet, header, { maxLines: MAX_LINES, ...(spec.directionValues ? { directionValues: spec.directionValues } : {}) });
    if (parsed.lines.length > MAX_LINES) throw new BankError('too_large', `Bir ekstre en fazla ${MAX_LINES} hareket icerebilir; donemi bolun`);
    if (parsed.lines.length === 0 && parsed.errors.length === 0) throw new BankError('unprocessable', 'Dosyada banka hareketi bulunamadi');
    const balances = checkBalances(parsed.lines);
    return {
      spec,
      formatSource,
      header,
      sourceFormat: sheet.format,
      lines: fingerprintLines(bankAccountId, parsed.lines),
      errors: parsed.errors,
      ignoredRows: parsed.ignoredRows,
      mismatchRows: balances.mismatches,
      ...(balances.openingBalance !== undefined ? { openingBalance: balances.openingBalance } : {}),
      ...(balances.closingBalance !== undefined ? { closingBalance: balances.closingBalance } : {}),
    };
  }

  const lineSkOf = (apartmentId: string, bankAccountId: string, l: FingerprintedLine) =>
    bankKeys.line(apartmentId, bankAccountId, l.date, l.fingerprint).SK;

  function summarize(a: Analysis, duplicatesExisting: number, overlapping: string[]) {
    const writable = a.lines.filter((l) => !l.duplicateInFile);
    const total = (dir: 'in' | 'out') => {
      const ls = writable.filter((l) => l.direction === dir);
      return { count: ls.length, amount: ls.reduce((s, l) => s + l.amount, 0) as Kurus };
    };
    const dates = writable.map((l) => l.date).sort();
    const issues: StatementIssues = {
      errors: a.errors.length,
      duplicatesInFile: a.lines.length - writable.length,
      duplicatesExisting,
      balanceMismatches: a.mismatchRows.size,
      weakFingerprints: writable.filter((l) => l.weak).length,
      overlappingStatements: overlapping,
      ignoredRows: a.ignoredRows,
    };
    return {
      lineCount: writable.length,
      credits: total('in'),
      debits: total('out'),
      issues,
      ...(dates.length ? { period: { from: dates[0] as IsoDate, to: dates[dates.length - 1] as IsoDate } } : {}),
    };
  }

  /** Commit oncesi onay isteyen durumlar. */
  function warningsOf(issues: StatementIssues): string[] {
    const w: string[] = [];
    if (issues.errors > 0) w.push(`${issues.errors} satir okunamadi ve aktarilmayacak`);
    if (issues.balanceMismatches > 0) w.push(`${issues.balanceMismatches} satirda bakiye onceki hareketle tutmuyor`);
    if (issues.weakFingerprints > 0 && issues.overlappingStatements.length > 0) {
      w.push('Bakiye/referans sutunu olmayan ekstre, daha once aktarilmis bir donemle cakisiyor: yarim gun iceren ekstrelerde tekrarlar ayirt edilemeyebilir');
    }
    return w;
  }

  async function overlappingStatements(apartmentId: string, bankAccountId: string, selfId: string, period?: { from: IsoDate; to: IsoDate }) {
    if (!period) return [];
    const all = await deps.repo.listStatements(apartmentId);
    return all
      .filter((s) => s.statementId !== selfId && s.bankAccountId === bankAccountId && s.status === 'committed' && s.period)
      .filter((s) => (s.period as { from: IsoDate; to: IsoDate }).from <= period.to && (s.period as { from: IsoDate; to: IsoDate }).to >= period.from)
      .map((s) => s.statementId);
  }

  async function readFile(key: string): Promise<{ bytes: Uint8Array; sha: string }> {
    const store = requireStore();
    const head = await store.head(key);
    if (!head) throw new BankError('not_found', 'Ekstre dosyasi bulunamadi: once yukleme baglantisiyla dosyayi yukleyin');
    if (head.size > MAX_FILE_BYTES) throw new BankError('too_large', `Dosya en fazla ${MAX_FILE_BYTES / 1024 / 1024} MB olabilir`);
    const bytes = await store.getBytes(key, MAX_FILE_BYTES);
    if (!bytes) throw new BankError('not_found', 'Ekstre dosyasi bulunamadi');
    return { bytes, sha: sha256(bytes) };
  }

  const auditDraft = (ctx: BankContext, action: string, s: BankStatement, details: Record<string, unknown> = {}): AuditDraft => ({
    apartmentId: ctx.apartmentId,
    action,
    target: { type: 'bank_statement', id: s.statementId },
    actorId: ctx.userId,
    details: {
      bankAccountId: s.bankAccountId,
      fileName: s.fileName,
      fileSha256: s.fileSha256,
      period: s.period,
      lineCount: s.lineCount,
      credits: s.credits,
      debits: s.debits,
      formatSource: s.formatSource,
      ...details,
    },
  });

  // -------------------------------------------------------------------------
  // Uclar
  // -------------------------------------------------------------------------

  return {
    templates() {
      return { items: BANK_TEMPLATES.map((t) => ({ id: t.id, name: t.name, verified: t.verified })) };
    },

    async createUploadUrl(ctx: BankContext, body: unknown) {
      const store = requireStore();
      const o = asObj(body);
      await requireBankAccount(ctx.apartmentId, o.bankAccountId);
      readFileName(o.fileName);
      if (!isUploadContentType(o.contentType)) fail('contentType desteklenmiyor (CSV, XLSX veya bankanin Excel/HTML ciktisi)', 'contentType');
      const size = o.size;
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) fail('size pozitif tam sayi olmalidir', 'size');
      if ((size as number) > MAX_FILE_BYTES) throw new BankError('too_large', `Dosya en fazla ${MAX_FILE_BYTES / 1024 / 1024} MB olabilir`);
      const now = deps.now();
      const statementId = `${istanbulDate(now).replaceAll('-', '')}-${deps.newId()}`;
      if (!isStatementId(statementId)) throw new Error('statementId uretilemedi');
      const contentType = o.contentType as string;
      const uploadUrl = await store.presignPut(statementFileKey(ctx.apartmentId, statementId), {
        contentType,
        contentLength: size as number,
        expiresIn: UPLOAD_URL_TTL_SECONDS,
      });
      return {
        statementId,
        uploadUrl,
        method: 'PUT' as const,
        headers: { 'Content-Type': contentType },
        expiresAt: new Date(now.getTime() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
        maxBytes: MAX_FILE_BYTES,
      };
    },

    async preview(ctx: BankContext, body: unknown) {
      const o = asObj(body);
      if (!isStatementId(o.statementId)) fail('statementId gecersiz', 'statementId');
      const statementId = o.statementId as string;
      const bankAccountId = await requireBankAccount(ctx.apartmentId, o.bankAccountId);
      const fileName = readFileName(o.fileName);
      const requested = o.format === undefined ? undefined : validateSpec(o.format);

      const existing = await deps.repo.getStatement(ctx.apartmentId, statementId);
      if (existing?.status === 'committed') {
        throw new BankError('already_committed', 'Bu ekstre zaten aktarildi', { statementId });
      }
      if (existing && existing.bankAccountId !== bankAccountId) {
        throw new BankError('conflict', 'Onizlenmis ekstrenin banka hesabi degistirilemez; dosyayi yeniden yukleyin');
      }

      const fileKey = statementFileKey(ctx.apartmentId, statementId);
      const { bytes, sha } = await readFile(fileKey);
      if (existing && existing.fileSha256 !== sha) {
        throw new BankError('file_changed', 'Dosya onizlemeden sonra degisti; yeni bir yukleme baslatin');
      }
      if (!existing) {
        const lock = await deps.repo.getFileLock(ctx.apartmentId, sha);
        if (lock) {
          const other = await deps.repo.getStatement(ctx.apartmentId, lock.statementId);
          throw new BankError('duplicate_file', 'Bu dosya daha once yuklendi', { existingStatementId: lock.statementId, status: other?.status });
        }
      }

      const a = await analyze(ctx, bankAccountId, bytes, requested);
      const writable = a.lines.filter((l) => !l.duplicateInFile);
      const existingSks = await deps.repo.existingLineKeys(ctx.apartmentId, writable.map((l) => lineSkOf(ctx.apartmentId, bankAccountId, l)));
      const draftSummary = summarize(a, 0, []);
      const overlapping = await overlappingStatements(ctx.apartmentId, bankAccountId, statementId, draftSummary.period);
      const summary = summarize(a, existingSks.size, overlapping);

      const now = deps.now().toISOString();
      const statement: BankStatement = {
        ...bankKeys.statement(ctx.apartmentId, statementId),
        entityType: 'BANK_STATEMENT',
        statementId,
        apartmentId: ctx.apartmentId,
        bankAccountId,
        status: 'previewed',
        fileName,
        fileKey,
        fileSha256: sha,
        fileBytes: bytes.byteLength,
        sourceFormat: a.sourceFormat,
        format: a.spec,
        formatSource: a.formatSource,
        ...summary,
        ...(a.openingBalance !== undefined ? { openingBalance: a.openingBalance } : {}),
        ...(a.closingBalance !== undefined ? { closingBalance: a.closingBalance } : {}),
        createdAt: existing?.createdAt ?? now,
        createdBy: existing?.createdBy ?? ctx.userId,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: (existing?.version ?? 0) + 1,
      };

      if (existing) {
        try {
          await deps.repo.replaceStatement(statement, existing.version, auditDraft(ctx, 'bank.statement.preview', statement, { repreview: true }));
        } catch (err) {
          if (err instanceof DataAccessError && err.code === 'conflict') {
            throw new BankError('version_conflict', 'Ekstre baska bir istekle guncellendi; yeniden deneyin');
          }
          throw err;
        }
      } else {
        const lock: BankFileLock = {
          ...bankKeys.fileLock(ctx.apartmentId, sha),
          entityType: 'BANK_FILE',
          apartmentId: ctx.apartmentId,
          fileSha256: sha,
          statementId,
          bankAccountId,
          createdAt: now,
          createdBy: ctx.userId,
        };
        try {
          await deps.repo.createStatement(statement, lock, auditDraft(ctx, 'bank.statement.preview', statement));
        } catch (err) {
          if (err instanceof DataAccessError && err.code === 'conflict') {
            const other = await deps.repo.getFileLock(ctx.apartmentId, sha);
            if (other && other.statementId !== statementId) {
              throw new BankError('duplicate_file', 'Bu dosya daha once yuklendi', { existingStatementId: other.statementId });
            }
            throw new BankError('version_conflict', 'Ekstre ayni anda baska bir istekle olusturuldu; yeniden deneyin');
          }
          throw err;
        }
      }

      const lines: PreviewLine[] = a.lines.map((l, i) => {
        const flags: PreviewLineFlag[] = [];
        if (l.duplicateInFile) flags.push('duplicate_in_file');
        else if (existingSks.has(lineSkOf(ctx.apartmentId, bankAccountId, l))) flags.push('duplicate_existing');
        if (a.mismatchRows.has(i)) flags.push('balance_mismatch');
        if (l.weak) flags.push('weak_fingerprint');
        return {
          lineId: lineIdOf(l.date, l.fingerprint),
          sourceRow: l.sourceRow,
          date: l.date,
          ...(l.valueDate ? { valueDate: l.valueDate } : {}),
          direction: l.direction,
          amount: l.amount,
          ...(l.balanceAfter !== undefined ? { balanceAfter: l.balanceAfter } : {}),
          description: l.description,
          ...(l.counterpartyName ? { counterpartyName: l.counterpartyName } : {}),
          ...(l.counterpartyIbanMasked ? { counterpartyIbanMasked: l.counterpartyIbanMasked } : {}),
          ...(l.bankReference ? { bankReference: l.bankReference } : {}),
          flags,
        };
      });

      return {
        statement: publicStatement(statement),
        header: { row: a.header.headerRowIndex + 1, columns: a.header.columns },
        lines,
        errors: a.errors.slice(0, 200),
        warnings: warningsOf(statement.issues),
      };
    },

    async commit(ctx: BankContext, statementId: string, body: unknown) {
      if (!isStatementId(statementId)) throw new BankError('not_found', 'Ekstre bulunamadi');
      const o = asObj(body);
      const st = await deps.repo.getStatement(ctx.apartmentId, statementId);
      if (!st) throw new BankError('not_found', 'Ekstre bulunamadi');
      if (st.status === 'committed') {
        return { statement: publicStatement(st), alreadyCommitted: true, written: 0, existing: st.committed?.existingLines ?? 0 };
      }
      if (typeof o.expectedVersion !== 'number' || o.expectedVersion !== st.version) {
        throw new BankError('version_conflict', 'Onizleme guncel degil; ekstreyi yeniden onizleyin', { currentVersion: st.version });
      }
      const warnings = warningsOf(st.issues);
      if (warnings.length && o.acknowledgeWarnings !== true) {
        throw new BankError('warnings_unacknowledged', 'Aktarimdan once uyarilar onaylanmalidir (acknowledgeWarnings: true)', { warnings });
      }
      const macer = requireMacer();

      const { bytes, sha } = await readFile(st.fileKey);
      if (sha !== st.fileSha256) throw new BankError('file_changed', 'Dosya onizlemeden sonra degisti; yeni bir yukleme baslatin');
      const a = await analyze(ctx, st.bankAccountId, bytes, st.format);
      const writable = a.lines.filter((l) => !l.duplicateInFile);

      // IBAN -> HMAC ozeti; duz IBAN bu noktadan sonra hicbir nesnede tasinmaz.
      const macs = await macAll(macer, ctx.apartmentId, writable.flatMap((l) => (l.counterpartyIban ? [l.counterpartyIban] : [])));
      const now = deps.now().toISOString();
      const lines: BankLine[] = writable.map((l) => ({
        ...bankKeys.line(ctx.apartmentId, st.bankAccountId, l.date, l.fingerprint),
        entityType: 'BANK_LINE',
        lineId: lineIdOf(l.date, l.fingerprint),
        apartmentId: ctx.apartmentId,
        bankAccountId: st.bankAccountId,
        statementId,
        sourceRow: l.sourceRow,
        date: l.date,
        ...(l.valueDate ? { valueDate: l.valueDate } : {}),
        direction: l.direction,
        amount: l.amount as Kurus,
        ...(l.balanceAfter !== undefined ? { balanceAfter: l.balanceAfter } : {}),
        description: l.description,
        ...(l.counterpartyName ? { counterpartyName: l.counterpartyName } : {}),
        ...(l.counterpartyIban
          ? { counterpartyIbanMasked: l.counterpartyIbanMasked as string, counterpartyIbanMac: macs.get(l.counterpartyIban) as string }
          : {}),
        ...(l.bankReference ? { bankReference: l.bankReference } : {}),
        fingerprint: l.fingerprint,
        fingerprintVersion: FINGERPRINT_VERSION,
        ...(l.weak ? { weakFingerprint: true as const } : {}),
        status: 'unmatched',
        createdAt: now,
        createdBy: ctx.userId,
        version: 1,
      }));

      // Yarida kalmis onceki deneme bu ekstrenin satirlarini yazmis olabilir: onlar "yeni" sayilir.
      const before = await deps.repo.existingLineStatements(ctx.apartmentId, lines.map((l) => l.SK));
      const ownPrior = [...before.values()].filter((sid) => sid === statementId).length;
      const result = await deps.repo.putLinesIfAbsent(ctx.apartmentId, lines);

      const next: BankStatement = {
        ...st,
        status: 'committed',
        committed: {
          newLines: result.written + ownPrior,
          existingLines: Math.max(0, result.existing - ownPrior),
          committedAt: now,
          committedBy: ctx.userId,
        },
        updatedAt: now,
        updatedBy: ctx.userId,
        version: st.version + 1,
      };
      try {
        await deps.repo.replaceStatement(next, st.version, auditDraft(ctx, 'bank.statement.commit', next, { committed: next.committed }));
      } catch (err) {
        if (err instanceof DataAccessError && err.code === 'conflict') {
          const latest = await deps.repo.getStatement(ctx.apartmentId, statementId);
          if (latest?.status === 'committed') {
            return { statement: publicStatement(latest), alreadyCommitted: true, written: 0, existing: latest.committed?.existingLines ?? 0 };
          }
          throw new BankError('version_conflict', 'Ekstre baska bir istekle guncellendi; yeniden onizleyin');
        }
        throw err;
      }
      return { statement: publicStatement(next), alreadyCommitted: false, written: next.committed?.newLines ?? 0, existing: next.committed?.existingLines ?? 0 };
    },

    async listStatements(ctx: BankContext, query: { bankAccountId?: string }) {
      if (query.bankAccountId !== undefined && !ID_PATTERN.test(query.bankAccountId)) fail('bankAccountId gecersiz', 'bankAccountId');
      const all = await deps.repo.listStatements(ctx.apartmentId);
      return { items: all.filter((s) => !query.bankAccountId || s.bankAccountId === query.bankAccountId).map(publicStatement) };
    },

    async getStatement(ctx: BankContext, statementId: string) {
      if (!isStatementId(statementId)) throw new BankError('not_found', 'Ekstre bulunamadi');
      const st = await deps.repo.getStatement(ctx.apartmentId, statementId);
      if (!st) throw new BankError('not_found', 'Ekstre bulunamadi');
      return { statement: publicStatement(st), warnings: st.status === 'previewed' ? warningsOf(st.issues) : [] };
    },

    async listLines(ctx: BankContext, q: Record<string, string | undefined>) {
      const bankAccountId = q.bankAccountId;
      if (!bankAccountId || !ID_PATTERN.test(bankAccountId)) fail('bankAccountId zorunludur', 'bankAccountId');
      if (q.status !== undefined && !(LINE_STATUSES as readonly string[]).includes(q.status)) fail(`status su degerlerden biri olmalidir: ${LINE_STATUSES.join(', ')}`, 'status');
      for (const k of ['from', 'to'] as const) if (q[k] !== undefined && !isIsoDate(q[k] as string)) fail(`${k} YYYY-AA-GG olmalidir`, k);
      if (q.from && q.to && q.from > q.to) fail('from, to tarihinden sonra olamaz', 'from');
      if (q.statementId !== undefined && !isStatementId(q.statementId)) fail('statementId gecersiz', 'statementId');
      if (q.order !== undefined && q.order !== 'asc' && q.order !== 'desc') fail('order asc veya desc olmalidir', 'order');
      const limit = q.limit === undefined ? 50 : Number(q.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > LINES_PAGE_MAX) fail(`limit 1-${LINES_PAGE_MAX} olmalidir`, 'limit');
      if (q.cursor !== undefined && (q.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(q.cursor))) fail('Gecersiz sayfalama imleci', 'cursor');
      const page = await deps.repo.queryLines(ctx.apartmentId, {
        bankAccountId: bankAccountId as string,
        limit,
        ...(q.status ? { status: q.status as LineStatus } : {}),
        ...(q.from ? { from: q.from } : {}),
        ...(q.to ? { to: q.to } : {}),
        ...(q.statementId ? { statementId: q.statementId } : {}),
        ...(q.order ? { order: q.order as 'asc' | 'desc' } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
      });
      return { items: page.items.map(publicLine), ...(page.cursor ? { cursor: page.cursor } : {}) };
    },

    async getFormat(ctx: BankContext, bankAccountId: string) {
      if (!ID_PATTERN.test(bankAccountId)) fail('bankAccountId gecersiz', 'bankAccountId');
      const f = await deps.repo.getFormat(ctx.apartmentId, bankAccountId);
      return { bankAccountId, format: f?.spec ?? null, version: f?.version ?? null, updatedAt: f?.updatedAt ?? null };
    },

    async putFormat(ctx: BankContext, rawAccountId: string, body: unknown) {
      const bankAccountId = await requireBankAccount(ctx.apartmentId, rawAccountId);
      const o = asObj(body);
      const spec = validateSpec(o.format);
      const expected = o.expectedVersion;
      if (expected !== undefined && (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1)) {
        fail('expectedVersion pozitif tam sayi olmalidir', 'expectedVersion');
      }
      const current = await deps.repo.getFormat(ctx.apartmentId, bankAccountId);
      if (current && expected === undefined) {
        throw new BankError('version_conflict', 'Kayitli esleme var; guncellemek icin expectedVersion verin', { currentVersion: current.version });
      }
      const now = deps.now().toISOString();
      const format: BankFormat = {
        ...bankKeys.format(ctx.apartmentId, bankAccountId),
        entityType: 'BANK_FORMAT',
        apartmentId: ctx.apartmentId,
        bankAccountId,
        spec,
        createdAt: current?.createdAt ?? now,
        createdBy: current?.createdBy ?? ctx.userId,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: current ? current.version + 1 : 1,
      };
      try {
        await deps.repo.saveFormat(format, current ? (expected as number) : undefined, {
          apartmentId: ctx.apartmentId,
          action: 'bank.format.save',
          target: { type: 'bank_format', id: bankAccountId },
          actorId: ctx.userId,
          details: { amountMode: spec.amountMode, columns: spec.columns, headerRow: spec.headerRow, templateId: spec.templateId, version: format.version },
        });
      } catch (err) {
        if (err instanceof DataAccessError && err.code === 'conflict') {
          throw new BankError('version_conflict', 'Esleme baska bir istekle degisti; yeniden yukleyip tekrar deneyin');
        }
        throw err;
      }
      return { bankAccountId, format: spec, version: format.version, updatedAt: now };
    },
  };
}

export type BankService = ReturnType<typeof createBankService>;
