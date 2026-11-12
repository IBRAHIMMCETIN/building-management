import type { ImportJob, ImportRowResult, StartImportInput } from '@/lib/api/imports';
import { type ImportRow, type ImportSheets, type ReportLine, SHEET_KINDS, type SheetKind, toChunks } from './sheetModel';

/*
 * Aktarim yurutucusu: start -> parcalar (25 satir, daireler -> kisiler -> bakiyeler) -> kasa/banka
 * -> complete. Sunucu her satiri idempotent isler; baglanti koparsa ayni `importId` ile
 * `state.cursor`dan devam edilir, ayni parca tekrar gitse bile ikinci kez yazilmaz.
 */

export type ImportRunApi = {
  start: (input: StartImportInput) => Promise<ImportJob>;
  rows: (id: string, kind: SheetKind, rows: ImportRow[]) => Promise<{ results: ImportRowResult[] }>;
  funds: (id: string, input: { cash?: string; bank?: string }) => Promise<{ funds: { account: 'cash' | 'bank'; outcome: ImportRowResult['outcome']; message?: string }[] }>;
  complete: (id: string) => Promise<ImportJob>;
};

export type ImportPlan = {
  importId: string;
  asOfDate: string;
  fileName: string;
  sheets: ImportSheets;
  /** Kurus; 0/undefined -> girilmez. */
  cash?: number;
  bank?: number;
};

export type FundsResult = { account: 'cash' | 'bank'; outcome: ImportRowResult['outcome']; message?: string };

export type ImportRunState = {
  /** Islenen parca sayisi (devam noktasi). */
  cursor: number;
  totalChunks: number;
  processedRows: number;
  totalRows: number;
  results: ImportRowResult[];
  funds?: FundsResult[];
  job?: ImportJob;
};

export function initialRunState(plan: ImportPlan): ImportRunState {
  const chunks = toChunks(plan.sheets);
  return { cursor: 0, totalChunks: chunks.length, processedRows: 0, totalRows: chunks.reduce((n, c) => n + c.rows.length, 0), results: [] };
}

/** Kurus -> API metni ("5000.00"); sunucu parseSignedKurus ile ayni kurala gore okur. */
export const kurusToApiText = (kurus: number) => `${Math.trunc(kurus / 100)}.${String(kurus % 100).padStart(2, '0')}`;

export async function runImport(
  api: ImportRunApi,
  plan: ImportPlan,
  from: ImportRunState,
  onProgress: (state: ImportRunState) => void,
): Promise<ImportRunState> {
  const chunks = toChunks(plan.sheets);
  let state = { ...from };
  const totals = Object.fromEntries(SHEET_KINDS.map((k) => [k, plan.sheets[k].length])) as Record<SheetKind, number>;
  await api.start({ importId: plan.importId, asOfDate: plan.asOfDate, fileName: plan.fileName, totals });

  for (let i = state.cursor; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const r = await api.rows(plan.importId, chunk.kind, chunk.rows);
    state = { ...state, cursor: i + 1, processedRows: state.processedRows + chunk.rows.length, results: [...state.results, ...r.results] };
    onProgress(state);
  }

  if (!state.funds) {
    const input: { cash?: string; bank?: string } = {};
    if (plan.cash && plan.cash > 0) input.cash = kurusToApiText(plan.cash);
    if (plan.bank && plan.bank > 0) input.bank = kurusToApiText(plan.bank);
    const funds = input.cash || input.bank ? (await api.funds(plan.importId, input)).funds : [];
    state = { ...state, funds };
    onProgress(state);
  }

  const job = await api.complete(plan.importId);
  state = { ...state, job };
  onProgress(state);
  return state;
}

export type RunSummary = {
  bySheet: Record<SheetKind, { created: number; exists: number; error: number }>;
  errors: ReportLine[];
};

export function summarize(state: Pick<ImportRunState, 'results' | 'funds'>): RunSummary {
  const bySheet = Object.fromEntries(SHEET_KINDS.map((k) => [k, { created: 0, exists: 0, error: 0 }])) as RunSummary['bySheet'];
  const errors: ReportLine[] = [];
  for (const r of state.results) {
    bySheet[r.sheet][r.outcome]++;
    if (r.outcome === 'error') errors.push({ sheet: r.sheet, row: r.row, label: r.label, message: r.message ?? 'Hata' });
  }
  for (const f of state.funds ?? []) {
    if (f.outcome === 'error') errors.push({ sheet: 'funds', label: f.account === 'cash' ? 'Kasa' : 'Banka', message: f.message ?? 'Hata' });
  }
  return { bySheet, errors };
}
