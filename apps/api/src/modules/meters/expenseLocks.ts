/**
 * Finans 2.3-5a - Fatura cift dagitim kilidi (`EXPDIST#<expenseId>`).
 *
 * Bir tedarikci faturasi (gider kaydi) ayni anda yalnizca bir sayac donemine bagli olabilir. Kilit
 * kayitlari donem yazimiyla AYNI atomik islemde olusturulur (`attribute_not_exists`) veya surum
 * kosuluyla devralinir; iki istek ayni faturayi ayni anda baglarsa biri kosul hatasiyla 409 alir.
 *  - bag / donem olusturma  -> kilit `active` (periodId)
 *  - bag kaldirma / iptal   -> `released`
 *  - geri alma tamamlaninca -> `released` (duzeltilmis donem yeniden alir)
 */
import { MeterError } from './errors.js';
import { type MeterRepository, type MeterWrite, meterKeys } from './repository.js';
import type { MeterExpenseLock } from './types.js';

export const MAX_EXPENSES_PER_PERIOD = 20;

export async function planExpenseLocks(
  repo: Pick<MeterRepository, 'get'>,
  p: { apartmentId: string; periodId: string; acquire: readonly string[]; release: readonly string[]; actorId: string; at: string },
): Promise<MeterWrite[]> {
  const writes: MeterWrite[] = [];
  for (const expenseId of p.acquire) {
    const key = meterKeys.expenseLock(p.apartmentId, expenseId);
    const cur = await repo.get<MeterExpenseLock>(key);
    if (cur?.status === 'active') {
      if (cur.periodId === p.periodId) continue;
      throw new MeterError('conflict', `Bu fatura (${expenseId}) başka bir sayaç dönemine bağlı; önce o dönemden çıkarın veya dönemi iptal / geri alın`, {
        expenseId,
        periodId: cur.periodId,
      });
    }
    const lock: MeterExpenseLock = {
      ...key,
      entityType: 'METER_EXPENSE_LOCK',
      apartmentId: p.apartmentId,
      expenseId,
      periodId: p.periodId,
      status: 'active',
      updatedAt: p.at,
      updatedBy: p.actorId,
      version: (cur?.version ?? 0) + 1,
    };
    writes.push(cur ? { op: 'replace', item: lock, expectedVersion: cur.version } : { op: 'create', item: lock });
  }
  for (const expenseId of p.release) {
    const key = meterKeys.expenseLock(p.apartmentId, expenseId);
    const cur = await repo.get<MeterExpenseLock>(key);
    if (!cur || cur.status !== 'active' || cur.periodId !== p.periodId) continue;
    writes.push({
      op: 'replace',
      item: { ...cur, status: 'released', updatedAt: p.at, updatedBy: p.actorId, version: cur.version + 1 },
      expectedVersion: cur.version,
    });
  }
  return writes;
}

/** Donemin faturalarinin kilidi bu donemde etkin mi? (onay oncesi kontrol) */
export async function lockProblems(repo: Pick<MeterRepository, 'get'>, apartmentId: string, periodId: string, expenseIds: readonly string[]) {
  const out: { expenseId: string; periodId?: string }[] = [];
  for (const expenseId of expenseIds) {
    const cur = await repo.get<MeterExpenseLock>(meterKeys.expenseLock(apartmentId, expenseId));
    if (!cur || cur.status !== 'active' || cur.periodId !== periodId) out.push({ expenseId, ...(cur?.status === 'active' ? { periodId: cur.periodId } : {}) });
  }
  return out;
}
