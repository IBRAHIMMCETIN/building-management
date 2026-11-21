/**
 * Online Odeme v2 · P4: platform komisyon faturasi altyapisi (entegratorden bagimsiz).
 *
 *  - Muhatap: apartman/site yonetimi (VKN; `PaymentAccount.invoiceRecipient`). Muhatap yoksa
 *    taslak `NEEDS_RECIPIENT` olur (fatura kesilemez).
 *  - Kapsam: yalnizca deftere yazilmis (SUCCEEDED) online odemelerin platform payi (`platformFee`,
 *    varsayilan %0,75). POS maliyeti saglayicinin faturasidir, buraya girmez. Iade edilen /
 *    incelemedeki odemeler satira girmez.
 *  - Model: `monthly` (varsayilan; donem `M-YYYY-MM`) veya `per_payment` (`P-<intentId>`).
 *  - KDV: `exclusive` (platform payi KDV haric; KDV ustune eklenir) veya `inclusive`.
 *  - Taslak idempotenttir: ayni donem yeniden uretildiginde satirlar degismediyse dokunulmaz,
 *    degistiyse surum artar. Kesilmis (ISSUED) / iptal edilmis taslak yeniden uretilmez.
 *  - `InvoiceProvider` (Parasut / Foriba / BizimHesap adaptoru ileride): `manual` saglayici
 *    entegrator olmadan calisir; fatura numarasi elle girilir.
 */
import { createHash } from 'node:crypto';
import { type IsoDate, type Kurus, toKurus } from '../core/types.js';
import { ValidationError, asObject, assertId } from '../core/validation.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import type { InvoiceSettings } from './config.js';
import { PaymentsConflictError, type PaymentsRepository, paymentKeys, paymentsRepository } from './repository.js';
import { PaymentsError, type PaymentsLog, defaultLog, utcStamp } from './service.js';
import { type InvoiceRecipient, PAYMENT_PROVIDERS, type PaymentIntent, type PlatformInvoice } from './types.js';

// ---------------------------------------------------------------------------
// Saglayici arayuzu
// ---------------------------------------------------------------------------

export type InvoiceIssueInput = { invoiceNumber?: string };
export type InvoiceIssueResult = { invoiceNumber: string; externalId?: string; issuedAt?: string };

/**
 * e-Fatura / e-Arsiv entegratoru. `createDraft` entegratorde taslak acar (istege bagli), `issue`
 * faturayi keser. Hatalarda `Error` firlatir; servis taslagi degistirmez.
 */
export interface InvoiceProvider {
  readonly name: string;
  createDraft?(invoice: PlatformInvoice): Promise<{ externalId?: string }>;
  issue(invoice: PlatformInvoice, input: InvoiceIssueInput): Promise<InvoiceIssueResult>;
}

/** Entegrator yok: fatura disarida (muhasebe programi) kesilir, numarasi burada kaydedilir. */
export const manualInvoiceProvider: InvoiceProvider = {
  name: 'manual',
  async issue(_invoice, input) {
    const n = input.invoiceNumber?.trim() ?? '';
    // GIB e-Fatura numarasi: 3 karakter seri + 4 hane yil + 9 hane sira (16 karakter); serbest
    // bicime de izin verilir (kagit/e-Arsiv), ama bos olamaz.
    if (n.length < 3 || n.length > 40 || !/^[A-Za-z0-9/_-]+$/.test(n)) {
      throw new ValidationError('invoiceNumber 3-40 karakter (harf, rakam, / _ -) olmalıdır', 'invoiceNumber');
    }
    return { invoiceNumber: n };
  },
};

// ---------------------------------------------------------------------------
// Hesap
// ---------------------------------------------------------------------------

/** KDV: `exclusive` -> KDV = round(net x oran), toplam = net + KDV; `inclusive` -> net = round(toplam / (1 + oran)). */
export function invoiceTotals(fees: Kurus, vatRateBasisPoints: number, vatMode: 'exclusive' | 'inclusive') {
  const f = BigInt(fees);
  const r = BigInt(vatRateBasisPoints);
  if (vatMode === 'exclusive') {
    const vat = (f * r + 5_000n) / 10_000n; // yarim yukari
    return { netAmount: toKurus(Number(f)), vatAmount: toKurus(Number(vat)), totalAmount: toKurus(Number(f + vat)) };
  }
  const net = (f * 10_000n * 2n + (10_000n + r)) / ((10_000n + r) * 2n); // yarim yukari
  return { netAmount: toKurus(Number(net)), vatAmount: toKurus(Number(f - net)), totalAmount: toKurus(Number(f)) };
}

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export function previousPeriod(day: IsoDate): string {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Donem siniri: niyet kimlikleri olusturma zamaniyla (UTC) siralidir; odeme gunu Istanbul'dur. */
function periodRange(period: string): { from: string; to: string } {
  const [y, m] = period.split('-').map(Number) as [number, number];
  // Odeme, niyetten en gec 24 saat sonra sonuclanir: 2 gun once baslanir; sonuna 1 gun pay.
  const from = new Date(Date.UTC(y, m - 1, 1) - 2 * 86_400_000);
  const to = new Date(Date.UTC(y, m, 1) + 86_400_000);
  return { from: utcStamp(from), to: `${utcStamp(to)}~` };
}

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

export type InvoiceServiceDeps = {
  repository?: PaymentsRepository;
  core?: Pick<CoreRepository, 'getSite' | 'listSiteIds'>;
  /** Varsayilan `manual` (entegrator yok). */
  provider?: InvoiceProvider;
  settings: InvoiceSettings;
  now?: () => Date;
  log?: PaymentsLog;
};

export function invoiceView(i: PlatformInvoice) {
  const { PK: _pk, SK: _sk, ...rest } = i;
  return rest;
}

export function createInvoiceService(overrides: InvoiceServiceDeps) {
  const deps = { repository: paymentsRepository, core: coreRepository, provider: manualInvoiceProvider, now: () => new Date(), log: defaultLog, ...overrides };
  const repo = deps.repository;
  const stamp = () => deps.now().toISOString();

  /** Apartmanin fatura muhatabi: herhangi bir saglayici hesabindaki ilk kayit. */
  async function recipientOf(apartmentId: string): Promise<InvoiceRecipient | undefined> {
    for (const p of PAYMENT_PROVIDERS) {
      const a = await repo.getAccount(apartmentId, p);
      if (a?.invoiceRecipient) return a.invoiceRecipient;
    }
    return undefined;
  }

  const billable = (i: PaymentIntent, period: string) =>
    i.status === 'SUCCEEDED' && (i.paidAt ?? '').startsWith(period) && i.platformFee > 0;

  function build(apartmentId: string, invoiceId: string, period: string, intents: PaymentIntent[], recipient: InvoiceRecipient | undefined, base?: PlatformInvoice): PlatformInvoice {
    const lines = intents
      .map((i) => ({ intentId: i.intentId, ...(i.paidAt ? { paidAt: i.paidAt } : {}), amount: i.amount, platformFee: i.platformFee }))
      .sort((a, b) => a.intentId.localeCompare(b.intentId));
    const fees = toKurus(lines.reduce((s, l) => s + l.platformFee, 0));
    const totals = invoiceTotals(fees, deps.settings.vatRateBasisPoints, deps.settings.vatMode);
    const ts = stamp();
    return {
      ...paymentKeys.invoice(apartmentId, invoiceId),
      entityType: 'PLATFORM_INVOICE',
      invoiceId,
      apartmentId,
      mode: deps.settings.mode,
      period,
      status: recipient ? 'DRAFT' : 'NEEDS_RECIPIENT',
      ...(recipient ? { recipient } : {}),
      lines,
      ...totals,
      vatRateBasisPoints: deps.settings.vatRateBasisPoints,
      vatMode: deps.settings.vatMode,
      reconciliation: {
        intentCount: lines.length,
        platformFeeTotal: fees,
        sourceHash: createHash('sha256').update(JSON.stringify({ lines, recipient: recipient ?? null, vat: [deps.settings.vatRateBasisPoints, deps.settings.vatMode] })).digest('hex'),
        generatedAt: ts,
      },
      invoiceProvider: deps.provider.name,
      ...(base?.externalId ? { externalId: base.externalId } : {}),
      createdAt: base?.createdAt ?? ts,
      updatedAt: ts,
      version: (base?.version ?? 0) + 1,
    };
  }

  /** Taslagi yazar; degismemis veya kesilmis/iptal kayda dokunmaz. */
  async function upsert(next: PlatformInvoice, current: PlatformInvoice | undefined): Promise<'created' | 'updated' | 'unchanged' | 'locked'> {
    if (current && (current.status === 'ISSUED' || current.status === 'CANCELLED')) return 'locked';
    if (current && current.reconciliation.sourceHash === next.reconciliation.sourceHash) return 'unchanged';
    let draft = next;
    if (!current && deps.provider.createDraft && next.status === 'DRAFT') {
      const r = await deps.provider.createDraft(next);
      if (r.externalId) draft = { ...next, externalId: r.externalId };
    }
    try {
      await repo.putInvoice(draft, current?.version);
    } catch (err) {
      if (err instanceof PaymentsConflictError) return 'unchanged'; // es zamanli uretim
      throw err;
    }
    return current ? 'updated' : 'created';
  }

  /** Bir apartmanin donem taslagi (aylik) veya donemdeki odeme bazli taslaklari. */
  async function draftPeriod(apartmentId: string, period: string) {
    assertId(apartmentId, 'apartmentId');
    if (!PERIOD.test(period)) throw new ValidationError('period YYYY-MM olmalıdır', 'period');
    const { from, to } = periodRange(period);
    const intents = (await repo.listIntentsBetween(apartmentId, from, to)).filter((i) => billable(i, period));
    const recipient = await recipientOf(apartmentId);
    const out = { period, mode: deps.settings.mode, created: 0, updated: 0, unchanged: 0, locked: 0, intents: intents.length };
    if (intents.length === 0) return out;
    const groups: [string, PaymentIntent[]][] =
      deps.settings.mode === 'monthly' ? [[`M-${period}`, intents]] : intents.map((i) => [`P-${i.intentId}`, [i]]);
    for (const [invoiceId, list] of groups) {
      const current = await repo.getInvoice(apartmentId, invoiceId);
      const r = await upsert(build(apartmentId, invoiceId, period, list, recipient, current), current);
      out[r]++;
    }
    if (!recipient) {
      deps.log('warn', 'platform faturasi muhatabi (VKN) yok', { apartmentId, period });
    }
    return out;
  }

  // ----- Platform -----

  async function listForApartment(apartmentId: string) {
    assertId(apartmentId, 'apartmentId');
    const items = await repo.listInvoices(apartmentId);
    return { items: items.sort((a, b) => b.invoiceId.localeCompare(a.invoiceId)).map(invoiceView) };
  }

  async function listForPeriod(period: string) {
    if (!PERIOD.test(period)) throw new ValidationError('period YYYY-MM olmalıdır', 'period');
    const ids = await deps.core.listSiteIds();
    const items: (ReturnType<typeof invoiceView> & { apartmentName: string | null })[] = [];
    for (const apartmentId of ids) {
      const list = (await repo.listInvoices(apartmentId)).filter((i) => i.period === period);
      if (list.length === 0) continue;
      const site = await deps.core.getSite(apartmentId);
      for (const i of list) items.push({ ...invoiceView(i), apartmentName: site?.name ?? null });
    }
    const totals = items
      .filter((i) => i.status !== 'CANCELLED')
      .reduce((s, i) => ({ net: s.net + i.netAmount, vat: s.vat + i.vatAmount, total: s.total + i.totalAmount }), { net: 0, vat: 0, total: 0 });
    return { period, items, totals };
  }

  async function load(apartmentId: string, invoiceId: string, expectedVersion: unknown) {
    assertId(apartmentId, 'apartmentId');
    assertId(invoiceId, 'invoiceId');
    const inv = await repo.getInvoice(apartmentId, invoiceId);
    if (!inv) throw new PaymentsError('not_found', 'Fatura taslağı bulunamadı');
    if (expectedVersion !== inv.version) throw new PaymentsError('conflict', 'Fatura taslağı değişti; güncel hali alıp tekrar deneyin');
    return inv;
  }

  /** Taslagi keser (saglayici veya elle girilen numara). Muhatapsiz taslak kesilemez. */
  async function issue(ctx: { userId: string }, apartmentId: string, invoiceId: string, body: unknown) {
    const o = asObject(body);
    const inv = await load(apartmentId, invoiceId, o.expectedVersion);
    if (inv.status !== 'DRAFT') {
      throw new PaymentsError('action_not_allowed', inv.status === 'NEEDS_RECIPIENT' ? 'Fatura muhatabı (VKN) eksik; ödeme hesabında invoiceRecipient girin ve taslağı yenileyin' : 'Yalnızca taslak fatura kesilebilir');
    }
    let r: InvoiceIssueResult;
    try {
      r = await deps.provider.issue(inv, { invoiceNumber: typeof o.invoiceNumber === 'string' ? o.invoiceNumber : undefined });
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      deps.log('error', 'platform faturasi kesilemedi', { apartmentId, invoiceId, provider: deps.provider.name, error: err instanceof Error ? err.message : 'unknown' });
      throw new PaymentsError('provider_unavailable', 'Fatura sağlayıcısına şu an ulaşılamıyor');
    }
    const next: PlatformInvoice = {
      ...inv,
      status: 'ISSUED',
      invoiceNumber: r.invoiceNumber,
      ...(r.externalId ? { externalId: r.externalId } : {}),
      issuedAt: r.issuedAt ?? stamp(),
      issuedBy: ctx.userId,
      updatedAt: stamp(),
      version: inv.version + 1,
    };
    await putOrConflict(next, inv.version);
    deps.log('info', 'AUDIT platform faturasi kesildi', { audit: 'PLATFORM_INVOICE_ISSUED', apartmentId, invoiceId, invoiceNumber: r.invoiceNumber, totalAmount: inv.totalAmount, by: ctx.userId });
    return invoiceView(next);
  }

  /** Kesilmemis taslagi iptal eder (kesilmis fatura icin iade faturasi gerekir; burada yapilmaz). */
  async function cancel(ctx: { userId: string }, apartmentId: string, invoiceId: string, body: unknown) {
    const o = asObject(body);
    const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
    if (reason.length < 5 || reason.length > 500) throw new ValidationError('reason 5-500 karakter olmalıdır', 'reason');
    const inv = await load(apartmentId, invoiceId, o.expectedVersion);
    if (inv.status !== 'DRAFT' && inv.status !== 'NEEDS_RECIPIENT') {
      throw new PaymentsError('action_not_allowed', 'Kesilmiş fatura burada iptal edilemez (iade faturası düzenleyin)');
    }
    const next: PlatformInvoice = { ...inv, status: 'CANCELLED', cancelledAt: stamp(), cancelReason: reason, issuedBy: ctx.userId, updatedAt: stamp(), version: inv.version + 1 };
    await putOrConflict(next, inv.version);
    deps.log('info', 'AUDIT platform faturasi taslagi iptal edildi', { audit: 'PLATFORM_INVOICE_CANCELLED', apartmentId, invoiceId, by: ctx.userId });
    return invoiceView(next);
  }

  async function putOrConflict(next: PlatformInvoice, expected: number) {
    try {
      await repo.putInvoice(next, expected);
    } catch (err) {
      if (err instanceof PaymentsConflictError) throw new PaymentsError('conflict', 'Fatura taslağı başka bir işlemle değişti');
      throw err;
    }
  }

  /** Platform: belirli apartman ve donem icin taslagi (yeniden) uretir. */
  async function draftForApartment(apartmentId: string, body: unknown) {
    const o = asObject(body);
    if (!(await deps.core.getSite(apartmentId))) throw new PaymentsError('not_found', 'Apartman bulunamadı');
    return draftPeriod(apartmentId, typeof o.period === 'string' ? o.period : '');
  }

  return { draftPeriod, draftForApartment, listForApartment, listForPeriod, issue, cancel };
}

export type InvoiceService = ReturnType<typeof createInvoiceService>;
