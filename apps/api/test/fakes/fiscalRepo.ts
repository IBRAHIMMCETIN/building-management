import type { AuditDraft } from '../../src/modules/audit/log.js';
import type { FinanceLock, FiscalPeriod } from '../../src/modules/finance/periodLock.js';
import { FiscalConflictError, type FiscalRepository } from '../../src/modules/finance/periodRepository.js';

type Docs = Map<string, Record<string, unknown> & { PK: string; SK: string; version: number }>;

/**
 * Bellek ici mali donem deposu. Kilit kaydi sahte finans deposunun `docs` haritasina yazilir
 * (`APT#<apt>|FINLOCK`); sahte `postBatch` kilidi oradan okur. Surum kosullari gercek depoyla ayni.
 */
export function createFakeFiscalRepo(docs: Docs) {
  const audits: AuditDraft[] = [];
  const key = (o: { PK: string; SK: string }) => `${o.PK}|${o.SK}`;
  const versionOf = (o: { PK: string; SK: string }) => (docs.get(key(o))?.version as number | undefined) ?? 0;
  const repo: FiscalRepository = {
    getLock: async (apt) => docs.get(`APT#${apt}|FINLOCK`) as FinanceLock | undefined,
    getPeriod: async (apt, period) => docs.get(`APT#${apt}|FPERIOD#${period}`) as FiscalPeriod | undefined,
    listPeriods: async (apt) =>
      [...docs.values()]
        .filter((d) => d.PK === `APT#${apt}` && d.SK.startsWith('FPERIOD#'))
        .map((d) => d as unknown as FiscalPeriod)
        .sort((a, b) => a.period.localeCompare(b.period)),
    async write(_apt, w) {
      if (versionOf(w.lock) !== w.expectedLockVersion) throw new FiscalConflictError();
      if (w.period && versionOf(w.period) !== (w.expectedPeriodVersion ?? 0)) throw new FiscalConflictError();
      docs.set(key(w.lock), structuredClone(w.lock) as never);
      if (w.period) docs.set(key(w.period), structuredClone(w.period) as never);
      if (w.audit) audits.push(w.audit);
    },
  };
  return { repo, audits };
}
