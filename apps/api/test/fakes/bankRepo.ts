import { DataAccessError } from '../../src/config/dynamodb.js';
import type { AuditDraft } from '../../src/modules/audit/log.js';
import { STATEMENT_PREFIX, linePrefix } from '../../src/modules/finance/bank/keys.js';
import { type BankRepository, decodeCursor, encodeCursor } from '../../src/modules/finance/bank/repository.js';
import type { BankFileLock, BankFormat, BankLine, BankStatement } from '../../src/modules/finance/bank/types.js';

/** Bellek ici banka deposu: kosullu yazim ve surum kurallari gercek depoyla ayni. */
export function createFakeBankRepo() {
  const items = new Map<string, Record<string, unknown>>();
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
  };

  const lines = (apt: string) => byPrefix<BankLine>(pkOf(apt), 'BANKTX#');
  return { repo, items, audits, lines };
}
