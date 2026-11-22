import { DataAccessError } from '../../src/config/dynamodb.js';
import type { AuditDraft } from '../../src/modules/audit/log.js';
import { STATEMENT_PREFIX, linePrefix } from '../../src/modules/finance/bank/keys.js';
import { type BankRepository, decodeCursor, encodeCursor } from '../../src/modules/finance/bank/repository.js';
import type {
  BankAccountProfile,
  BankAutoRun,
  BankDecision,
  BankFileLock,
  BankFormat,
  BankLine,
  BankPayer,
  BankRef,
  BankRefOf,
  BankStatement,
} from '../../src/modules/finance/bank/types.js';
import { parseLineId } from '../../src/modules/finance/bank/keys.js';

/**
 * Bellek ici banka deposu: kosullu yazim ve surum kurallari gercek depoyla ayni.
 * `shared`: sahte finans deposunun belge haritasi (`fin.docs`). Verilirse eslestirme yazimlari
 * (postBatch newDocs/replaceRecords) ile banka kayitlari ayni haritada durur (gercekte tek tablo).
 */
export function createFakeBankRepo(shared?: Map<string, Record<string, unknown>>) {
  const items = shared ?? new Map<string, Record<string, unknown>>();
  const audits: AuditDraft[] = [];
  const k = (pk: string, sk: string) => `${pk}|${sk}`;
  const clone = <T>(v: T): T => structuredClone(v);
  const byPrefix = <T>(pk: string, prefix: string) =>
    [...items.values()].filter((i) => i.PK === pk && String(i.SK).startsWith(prefix)).sort((a, b) => String(a.SK).localeCompare(String(b.SK))) as T[];
  const pkOf = (apt: string) => `APT#${apt}`;

  const repo: BankRepository = {
    async getStatement(apt, id) {
      const v = items.get(k(pkOf(apt), `BANKSTMT#${id}`));
      return v ? (clone(v) as BankStatement) : undefined;
    },
    async listStatements(apt) {
      return byPrefix<BankStatement>(pkOf(apt), STATEMENT_PREFIX).reverse().map(clone);
    },
    async getFileLock(apt, sha) {
      const v = items.get(k(pkOf(apt), `BANKFILE#${sha}`));
      return v ? (clone(v) as BankFileLock) : undefined;
    },
    async createStatement(statement, lock, audit) {
      if (items.has(k(statement.PK, statement.SK)) || items.has(k(lock.PK, lock.SK))) throw new DataAccessError('conflict', 'var');
      items.set(k(statement.PK, statement.SK), clone(statement));
      items.set(k(lock.PK, lock.SK), clone(lock));
      audits.push(audit);
    },
    async replaceStatement(statement, expectedVersion, audit) {
      const cur = items.get(k(statement.PK, statement.SK));
      if (!cur || cur.version !== expectedVersion) throw new DataAccessError('conflict', 'surum');
      items.set(k(statement.PK, statement.SK), clone(statement));
      audits.push(audit);
    },
    async existingLineKeys(apt, sks) {
      return new Set(sks.filter((sk) => items.has(k(pkOf(apt), sk))));
    },
    async existingLineStatements(apt, sks) {
      const m = new Map<string, string>();
      for (const sk of sks) {
        const v = items.get(k(pkOf(apt), sk));
        if (v) m.set(sk, String(v.statementId));
      }
      return m;
    },
    async putLinesIfAbsent(apt, lines) {
      let written = 0;
      let existing = 0;
      for (const l of lines) {
        if (l.PK !== pkOf(apt)) throw new Error('baska apartman');
        if (items.has(k(l.PK, l.SK))) existing++;
        else {
          items.set(k(l.PK, l.SK), clone(l));
          written++;
        }
      }
      return { written, existing };
    },
    async queryLines(apt, q) {
      const prefix = linePrefix(q.bankAccountId);
      const lo = `${prefix}${q.from ?? '0000-01-01'}`;
      const hi = `${prefix}${q.to ?? '9999-12-31'}#￿`;
      let all = byPrefix<BankLine>(pkOf(apt), prefix).filter((l) => l.SK >= lo && l.SK <= hi);
      if (q.order !== 'asc') all = all.reverse();
      if (q.cursor) {
        const c = decodeCursor(apt, q.bankAccountId, q.cursor);
        const i = all.findIndex((l) => l.SK === c.SK);
        all = all.slice(i + 1);
      }
      const filtered = all.filter((l) => (!q.status || l.status === q.status) && (!q.statementId || l.statementId === q.statementId));
      const page = filtered.slice(0, q.limit).map(clone);
      const last = page[page.length - 1];
      return { items: page, ...(filtered.length > q.limit && last ? { cursor: encodeCursor(last) } : {}) };
    },
    async getFormat(apt, acct) {
      const v = items.get(k(pkOf(apt), `BANKFMT#${acct}`));
      return v ? (clone(v) as BankFormat) : undefined;
    },
    async saveFormat(format, expectedVersion, audit) {
      const cur = items.get(k(format.PK, format.SK));
      if (expectedVersion === undefined ? Boolean(cur) : !cur || cur.version !== expectedVersion) throw new DataAccessError('conflict', 'surum');
      items.set(k(format.PK, format.SK), clone(format));
      audits.push(audit);
    },

    // ----- Faz B2 -----
    async getLine(apt, acct, lineId) {
      const p = parseLineId(lineId);
      if (!p) return undefined;
      const v = items.get(k(pkOf(apt), `BANKTX#${acct}#${p.date}#${p.fp}`));
      return v ? (clone(v) as BankLine) : undefined;
    },
    async listDecisions(apt, lineId) {
      return byPrefix<BankDecision>(pkOf(apt), `BANKMATCH#${lineId}#`).map(clone);
    },
    async writeDecision(line, expectedVersion, decision, audit) {
      const cur = items.get(k(line.PK, line.SK));
      if (items.has(k(decision.PK, decision.SK)) || !cur || cur.version !== expectedVersion) throw new DataAccessError('conflict', 'surum');
      items.set(k(decision.PK, decision.SK), clone(decision));
      items.set(k(line.PK, line.SK), clone(line));
      audits.push(audit);
    },
    async getPayer(apt, mac) {
      const v = items.get(k(pkOf(apt), `PAYER#${mac}`));
      return v ? (clone(v) as BankPayer) : undefined;
    },
    async listRefs(apt) {
      return byPrefix<BankRef>(pkOf(apt), 'BANKREF#').filter((r) => r.entityType === 'BANK_REF').map(clone);
    },
    async getRefOf(apt, accountId) {
      const v = items.get(k(pkOf(apt), `BANKREFOF#${accountId}`));
      return v ? (clone(v) as BankRefOf) : undefined;
    },
    async createRef(ref, refOf) {
      if (items.has(k(refOf.PK, refOf.SK))) return 'account_has_code';
      if (items.has(k(ref.PK, ref.SK))) return 'code_taken';
      items.set(k(ref.PK, ref.SK), clone(ref));
      items.set(k(refOf.PK, refOf.SK), clone(refOf));
      return 'created';
    },
    async getProfile(apt, acct) {
      const v = items.get(k(pkOf(apt), `BANKPROFILE#${acct}`));
      return v ? (clone(v) as BankAccountProfile) : undefined;
    },
    async listProfiles(apt) {
      return byPrefix<BankAccountProfile>(pkOf(apt), 'BANKPROFILE#').map(clone);
    },
    async saveProfile(profile, expectedVersion, others, audit) {
      const cur = items.get(k(profile.PK, profile.SK));
      if (expectedVersion === undefined ? Boolean(cur) : !cur || cur.version !== expectedVersion) throw new DataAccessError('conflict', 'surum');
      for (const o of others) {
        const c = items.get(k(o.item.PK, o.item.SK));
        if (!c || c.version !== o.expectedVersion) throw new DataAccessError('conflict', 'surum');
      }
      items.set(k(profile.PK, profile.SK), clone(profile));
      for (const o of others) items.set(k(o.item.PK, o.item.SK), clone(o.item));
      audits.push(audit);
    },

    // ----- Faz B3 -----
    async getAutoRun(apt, statementId, key) {
      const v = items.get(k(pkOf(apt), `BANKAUTO#${statementId}#${key}`));
      return v ? (clone(v) as BankAutoRun) : undefined;
    },
    async saveAutoRun(run, expectedVersion, audit) {
      const cur = items.get(k(run.PK, run.SK));
      if (expectedVersion === undefined ? Boolean(cur) : !cur || cur.version !== expectedVersion) throw new DataAccessError('conflict', 'surum');
      items.set(k(run.PK, run.SK), clone(run) as unknown as Record<string, unknown>);
      if (audit) audits.push(audit);
    },
  };

  const lines = (apt: string) => byPrefix<BankLine>(pkOf(apt), 'BANKTX#');
  const decisions = (apt: string) => byPrefix<BankDecision>(pkOf(apt), 'BANKMATCH#');
  return { repo, items, audits, lines, decisions };
}
