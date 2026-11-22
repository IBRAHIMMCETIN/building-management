import { skKey, tenantPk } from '../../../config/dynamodb.js';
import type { IsoDate } from '../../core/types.js';

/*
 * Anahtar duzeni (bkz. types.ts) ve S3 yolu:
 *   apartments/{apartmentId}/bank-statements/{yyyy}/{mm}/{statementId}
 * `statementId` = `YYYYMMDD-<uuid>`: yil/ay kimlikten turetilir; istemci yalnizca kimligi geri
 * gonderir, anahtar sunucuda JWT'deki apartmanla yeniden kurulur (baska apartmanin dosyasi
 * gosterilemez).
 */

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_LINES = 3000;
export const LINES_PAGE_MAX = 200;

export const STATEMENT_ID_PATTERN = /^(\d{4})(\d{2})(\d{2})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FP_PATTERN = /^[0-9a-f]{24}$/;

export const isStatementId = (v: unknown): v is string => typeof v === 'string' && STATEMENT_ID_PATTERN.test(v);

export function statementFileKey(apartmentId: string, statementId: string): string {
  const m = STATEMENT_ID_PATTERN.exec(statementId);
  if (!m) throw new Error('Gecersiz statementId');
  return `apartments/${apartmentId}/bank-statements/${m[1]}/${m[2]}/${statementId}`;
}

/** Yukleme turleri (tarayicinin bildirdigi icerik turu). Bicim dosya iceriginden ayrica tespit edilir. */
export const UPLOAD_CONTENT_TYPES = [
  'text/csv',
  'text/plain',
  'text/html',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
] as const;
export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];
export const isUploadContentType = (v: unknown): v is UploadContentType =>
  typeof v === 'string' && (UPLOAD_CONTENT_TYPES as readonly string[]).includes(v);

export const lineSk = (bankAccountId: string, date: IsoDate, fp: string) => skKey('BANKTX', bankAccountId, date, fp);

export const lineIdOf = (date: IsoDate, fp: string) => `${date.replaceAll('-', '')}_${fp}`;

/** `lineId` -> tarih + parmak izi (B2 uclari icin). */
export function parseLineId(lineId: string): { date: IsoDate; fp: string } | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})_([0-9a-f]{24})$/.exec(lineId);
  return m ? { date: `${m[1]}-${m[2]}-${m[3]}`, fp: m[4] as string } : undefined;
}

export const bankKeys = {
  statement: (apartmentId: string, statementId: string) => ({ PK: tenantPk(apartmentId), SK: skKey('BANKSTMT', statementId) }),
  fileLock: (apartmentId: string, sha256: string) => {
    if (!SHA256_PATTERN.test(sha256)) throw new Error('Gecersiz sha256');
    return { PK: tenantPk(apartmentId), SK: skKey('BANKFILE', sha256) };
  },
  line: (apartmentId: string, bankAccountId: string, date: IsoDate, fp: string) => {
    if (!FP_PATTERN.test(fp)) throw new Error('Gecersiz parmak izi');
    return { PK: tenantPk(apartmentId), SK: lineSk(bankAccountId, date, fp) };
  },
  format: (apartmentId: string, bankAccountId: string) => ({ PK: tenantPk(apartmentId), SK: skKey('BANKFMT', bankAccountId) }),
  // Faz B2
  decision: (apartmentId: string, lineId: string, decisionNo: number) => ({
    PK: tenantPk(apartmentId),
    SK: skKey('BANKMATCH', lineId, String(decisionNo).padStart(3, '0')),
  }),
  payer: (apartmentId: string, ibanMac: string) => ({ PK: tenantPk(apartmentId), SK: skKey('PAYER', ibanMac) }),
  ref: (apartmentId: string, code: string) => ({ PK: tenantPk(apartmentId), SK: skKey('BANKREF', code) }),
  refOf: (apartmentId: string, accountId: string) => ({ PK: tenantPk(apartmentId), SK: skKey('BANKREFOF', accountId) }),
  profile: (apartmentId: string, bankAccountId: string) => ({ PK: tenantPk(apartmentId), SK: skKey('BANKPROFILE', bankAccountId) }),
  // Faz B3
  autoRun: (apartmentId: string, statementId: string, idempotencyKey: string) => ({
    PK: tenantPk(apartmentId),
    SK: skKey('BANKAUTO', statementId, idempotencyKey),
  }),
};

/** Toplu onay istemci anahtari (UUID veya benzeri; anahtar SK'ya girer). */
export const AUTO_RUN_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const decisionPrefix = (lineId: string) => `BANKMATCH#${lineId}#`;
export const DECISION_PREFIX = 'BANKMATCH#';
export const REF_PREFIX = 'BANKREF#';
export const PROFILE_PREFIX = 'BANKPROFILE#';

export const STATEMENT_PREFIX = 'BANKSTMT#';
export const linePrefix = (bankAccountId: string) => `BANKTX#${bankAccountId}#`;

/** Europe/Istanbul takvim tarihi. */
export const istanbulDate = (d: Date): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(d);
