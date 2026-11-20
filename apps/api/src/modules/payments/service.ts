import { createHash, randomUUID } from 'node:crypto';
import type { Role } from '../../auth/claims.js';
import { DataAccessError } from '../../config/dynamodb.js';
import { type IsoDate, type IsoDateTime, type Kurus, type LiableParty, toKurus } from '../core/types.js';
import { ValidationError, asObject, assertId } from '../core/validation.js';
import { LedgerConflictError } from '../finance/repository.js';
import type { FinanceService } from '../finance/service.js';
import type { PortalRepository } from '../portal/repository.js';
import type { PortalService } from '../portal/service.js';
import {
  type CheckoutOutcome,
  type CheckoutRequest,
  type PaymentProvider,
  PaymentProviderError,
  SANDBOX_IDENTITY_NUMBER,
} from './provider.js';
import {
  type PaymentSelection,
  accruedLateFeeOf,
  allocateSelection,
  buildQuote,
  receivableAccountId,
} from './quote.js';
import { type PaymentsRepository, PaymentsConflictError, paymentKeys, paymentsRepository } from './repository.js';
import {
  type IntentKeyRecord,
  PAYMENT_MODES,
  type PaymentAccount,
  type PaymentIntent,
  type PaymentMode,
} from './types.js';

// ---------------------------------------------------------------------------
// Hatalar
// ---------------------------------------------------------------------------

export type PaymentsErrorCode =
  | 'not_found'
  | 'no_debt'
  | 'payments_disabled'
  | 'idempotency_conflict'
  | 'conflict'
  | 'provider_unavailable';

const STATUS: Record<PaymentsErrorCode, 404 | 409 | 422 | 502> = {
  not_found: 404,
  no_debt: 422,
  payments_disabled: 422,
  idempotency_conflict: 409,
  conflict: 409,
  provider_unavailable: 502,
};

export class PaymentsError extends Error {
  readonly code: PaymentsErrorCode;
  readonly httpStatus: 404 | 409 | 422 | 502;

  constructor(code: PaymentsErrorCode, message: string) {
    super(message);
    this.name = 'PaymentsError';
    this.code = code;
    this.httpStatus = STATUS[code];
  }
}

// ---------------------------------------------------------------------------
// Bagimliliklar
// ---------------------------------------------------------------------------

export const PAYMENT_ROLES: readonly Role[] = ['resident'];

export type PaymentsContext = { apartmentId: string; userId: string; role: Role };

export type PaymentsLog = (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;

export type PaymentsServiceDeps = {
  repository: PaymentsRepository;
  /** Odenebilir borc: portalin erisim kurallari (rol, aktif uyelik, uyelik donemi). */
  portal: Pick<PortalService, 'getPayableLedgers'>;
  /** Sonuclandirmada tazminat ust siniri icin alt carinin TUM satirlari (uyelikten bagimsiz). */
  ledger: Pick<PortalRepository, 'listLedgerEntries' | 'getTransactions'>;
  finance: Pick<FinanceService, 'recordOnlinePayment'>;
  /** Verilmezse online odeme kapali (quote calisir, odeme baslatilamaz). */
  provider?: PaymentProvider;
  /** API'nin disaridan erisilen adresi (saglayici callback'i buraya POST eder). */
  apiBaseUrl: string;
  /** Odeme sonrasi kullanicinin donecegi web uygulamasi (Cloudflare Pages). */
  webAppUrl: string;
  /** Saglayici sayfasinin gecerlilik suresi (dakika). */
  intentTtlMinutes: number;
  now: () => Date;
  newId: () => string;
  log: PaymentsLog;
};

const defaultLog: PaymentsLog = (level, message, fields = {}) => {
  const line = JSON.stringify({ level, module: 'payments', message, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

/** Mutabakat: bu sureden eski PENDING niyetler saglayicidan sorgulanir. */
export const RECONCILE_GRACE_MINUTES = 30;
/** Mutabakatin geriye bakis penceresi. */
export const RECONCILE_LOOKBACK_DAYS = 7;
/** Saglayici bu kadar sure sonra hala "pending" diyorsa niyet zaman asimina ugrar. */
export const PENDING_GIVE_UP_HOURS = 24;

const LIABLE_PARTIES = ['owner', 'occupant'] as const;
const PARTY_LABEL: Record<LiableParty, string> = { owner: 'Kat Maliki', occupant: 'Sakin' };
const MAX_SELECTED_ITEMS = 120;
const REF = /^([A-Za-z0-9_-]{1,64}):(\d{14}-[A-Za-z0-9_-]{1,64})$/;
const TCKN = /^[1-9]\d{10}$/;

const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** `2026-11-20T11:22:33.444Z` -> `20261120112233` (UTC, siralanabilir). */
export function utcStamp(d: Date): string {
  return d.toISOString().replace(/\D/g, '').slice(0, 14);
}

// ---------------------------------------------------------------------------
// Gorunum
// ---------------------------------------------------------------------------

export type IntentView = {
  intentId: string;
  status: PaymentIntent['status'];
  mode: PaymentMode;
  unitId: string;
  currency: 'TRY';
  amount: Kurus;
  allocations: { liableParty: LiableParty; principal: Kurus; lateFee: Kurus; amount: Kurus; transactionIds: string[] }[];
  /** Yalnizca PENDING iken: saglayicinin odeme sayfasi. */
  paymentPageUrl?: string;
  paidAt?: IsoDate;
  paymentIds?: string[];
  receiptNumbers?: string[];
  failureMessage?: string;
  expiresAt: IsoDateTime;
  createdAt: IsoDateTime;
};

function toView(i: PaymentIntent): IntentView {
  return {
    intentId: i.intentId,
    status: i.status,
    mode: i.mode,
    unitId: i.unitId,
    currency: 'TRY',
    amount: i.amount,
    // Platform payi ve alt uye tutari sakine gosterilmez (Karar B: apartmandan kesilir).
    allocations: i.allocations.map((a) => ({
      liableParty: a.liableParty,
      principal: a.principal,
      lateFee: a.lateFee,
      amount: a.amount,
      transactionIds: a.transactionIds,
    })),
    ...(i.status === 'PENDING' && i.checkout ? { paymentPageUrl: i.checkout.paymentPageUrl } : {}),
    paidAt: i.paidAt,
    paymentIds: i.paymentIds,
    receiptNumbers: i.receiptNumbers,
    ...(i.status === 'FAILED' && i.failure ? { failureMessage: i.failure.message } : {}),
    ...(i.status === 'NEEDS_REVIEW'
      ? { failureMessage: 'Ödemeniz alındı ancak kontrol edilmesi gerekiyor; yönetim sizinle iletişime geçecek.' }
      : {}),
    expiresAt: i.expiresAt,
    createdAt: i.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Girdi
// ---------------------------------------------------------------------------

type IntentInput = {
  idempotencyKey: string;
  unitId?: string;
  selection: PaymentSelection;
  identityNumber?: string;
};

function parseIntentInput(body: unknown): IntentInput {
  const o = asObject(body);
  const idempotencyKey = assertId(o.idempotencyKey, 'idempotencyKey');
  const unitId = o.unitId === undefined || o.unitId === null || o.unitId === '' ? undefined : assertId(o.unitId, 'unitId');
  const mode = o.mode;
  if (typeof mode !== 'string' || !(PAYMENT_MODES as readonly string[]).includes(mode)) {
    throw new ValidationError(`mode su degerlerden biri olmalidir: ${PAYMENT_MODES.join(', ')}`, 'mode');
  }
  let selection: PaymentSelection;
  if (mode === 'total') {
    if (o.items !== undefined) throw new ValidationError('Toplam borç ödemesinde kalem seçilmez', 'items');
    selection = { mode: 'total' };
  } else {
    if (!Array.isArray(o.items) || o.items.length === 0 || o.items.length > MAX_SELECTED_ITEMS) {
      throw new ValidationError(`items 1-${MAX_SELECTED_ITEMS} borç kalemi içermelidir`, 'items');
    }
    selection = {
      mode: 'items',
      items: o.items.map((raw, i) => {
        const it = asObject(raw, `items[${i}]`);
        const party = it.liableParty;
        if (typeof party !== 'string' || !(LIABLE_PARTIES as readonly string[]).includes(party)) {
          throw new ValidationError('liableParty owner veya occupant olmalidir', `items[${i}].liableParty`);
        }
        return { liableParty: party as LiableParty, transactionId: assertId(it.transactionId, `items[${i}].transactionId`) };
      }),
    };
  }
  let identityNumber: string | undefined;
  if (o.identityNumber !== undefined && o.identityNumber !== null && o.identityNumber !== '') {
    if (typeof o.identityNumber !== 'string' || !TCKN.test(o.identityNumber)) {
      throw new ValidationError('identityNumber 11 haneli T.C. kimlik numarası olmalıdır', 'identityNumber');
    }
    identityNumber = o.identityNumber;
  }
  return { idempotencyKey, unitId, selection, identityNumber };
}

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

export function createPaymentsService(overrides: Partial<PaymentsServiceDeps> & Pick<PaymentsServiceDeps, 'portal' | 'ledger' | 'finance'>) {
  const deps: PaymentsServiceDeps = {
    repository: paymentsRepository,
    apiBaseUrl: 'http://localhost:3000',
    webAppUrl: 'http://localhost:5173',
    intentTtlMinutes: 30,
    now: () => new Date(),
    newId: () => randomUUID(),
    log: defaultLog,
    ...overrides,
  };
  const repo = deps.repository;
  const provider = deps.provider;
  const apiBase = deps.apiBaseUrl.replace(/\/+$/, '');
  const webBase = deps.webAppUrl.replace(/\/+$/, '');

  const stamp = () => deps.now().toISOString();
  const today = (): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());

  /** Apartmanin aktif alt uye isyeri hesabi; sahte saglayicida varsayilan hesap. */
  async function activeAccount(apartmentId: string): Promise<Pick<PaymentAccount, 'subMerchantKey' | 'platformFeeBasisPoints'> | undefined> {
    if (!provider) return undefined;
    const account = await repo.getAccount(apartmentId, provider.name);
    if (account?.status === 'active') return account;
    if (!account && provider.name === 'fake') return { subMerchantKey: 'fake-submerchant', platformFeeBasisPoints: 0 };
    return undefined;
  }

  // ----- Odenebilir tutar -----

  async function quote(ctx: PaymentsContext, unitId?: string) {
    const data = await deps.portal.getPayableLedgers(ctx, unitId);
    const q = buildQuote({
      ledgers: data.ledgers,
      txById: data.txById,
      today: data.today,
      lateFeeMonthlyBasisPoints: data.lateFeeMonthlyBasisPoints,
    });
    const account = await activeAccount(ctx.apartmentId);
    return { unitId: data.unit.unitId, currency: 'TRY' as const, onlinePaymentEnabled: Boolean(account), ...q };
  }

  // ----- Niyet olusturma -----

  async function createIntent(ctx: PaymentsContext, body: unknown, meta: { ip: string }) {
    const input = parseIntentInput(body);
    if (!provider) throw new PaymentsError('payments_disabled', 'Online ödeme şu an kullanılamıyor');

    const fp = fingerprint({
      unitId: input.unitId ?? null,
      selection:
        input.selection.mode === 'total'
          ? { mode: 'total' }
          : {
              mode: 'items',
              items: [...input.selection.items]
                .map((i) => `${i.liableParty}:${i.transactionId}`)
                .sort(),
            },
    });

    const replay = async (): Promise<(IntentView & { replayed: true }) | undefined> => {
      const key = await repo.getIntentKey(ctx.apartmentId, ctx.userId, input.idempotencyKey);
      if (!key) return undefined;
      if (key.fingerprint !== fp) {
        throw new PaymentsError('idempotency_conflict', 'Bu idempotencyKey farklı bir ödeme isteğiyle kullanılmış');
      }
      const existing = await repo.getIntent(ctx.apartmentId, key.intentId);
      if (!existing || existing.userId !== ctx.userId) throw new PaymentsError('not_found', 'Ödeme bulunamadı');
      return { ...toView(existing), replayed: true };
    };
    const previous = await replay();
    if (previous) return previous;

    // Erisim (rol, aktif uyelik, daire secimi) portal kurallariyla dogrulanir.
    const data = await deps.portal.getPayableLedgers(ctx, input.unitId);
    const account = await activeAccount(ctx.apartmentId);
    if (!account) throw new PaymentsError('payments_disabled', 'Bu apartman için online ödeme henüz aktif değil');

    const q = buildQuote({
      ledgers: data.ledgers,
      txById: data.txById,
      today: data.today,
      lateFeeMonthlyBasisPoints: data.lateFeeMonthlyBasisPoints,
    });
    const plan = allocateSelection(q, input.selection, account.platformFeeBasisPoints);
    if (plan.amount < 1) throw new PaymentsError('no_debt', 'Ödenecek borcunuz bulunmuyor');

    const now = deps.now();
    const ts = now.toISOString();
    const intentId = `${utcStamp(now)}-${deps.newId()}`;
    const intent: PaymentIntent = {
      ...paymentKeys.intent(ctx.apartmentId, intentId),
      entityType: 'PAYMENT_INTENT',
      intentId,
      apartmentId: ctx.apartmentId,
      unitId: data.unit.unitId,
      userId: ctx.userId,
      mode: plan.mode,
      allocations: plan.allocations,
      amount: plan.amount,
      platformFee: plan.platformFee,
      currency: 'TRY',
      lateFeeAsOf: q.asOf,
      lateFeeMonthlyBasisPoints: q.lateFeeMonthlyBasisPoints,
      provider: provider.name,
      subMerchantKey: account.subMerchantKey,
      conversationId: `${ctx.apartmentId}:${intentId}`,
      status: 'PENDING',
      expiresAt: new Date(now.getTime() + deps.intentTtlMinutes * 60_000).toISOString(),
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      version: 1,
    };
    const keyRecord: IntentKeyRecord = {
      ...paymentKeys.intentKey(ctx.apartmentId, ctx.userId, input.idempotencyKey),
      entityType: 'PAYMENT_INTENT_KEY',
      intentId,
      fingerprint: fp,
      createdAt: ts,
    };
    try {
      await repo.createIntent(intent, keyRecord);
    } catch (err) {
      if (err instanceof PaymentsConflictError) {
        // Ayni anahtarla es zamanli istek: digerinin sonucu doner.
        const again = await replay();
        if (again) return again;
        throw new PaymentsError('conflict', 'Eş zamanlı bir ödeme isteği oldu, tekrar deneyin');
      }
      throw err;
    }

    const request: CheckoutRequest = {
      intentId,
      conversationId: intent.conversationId,
      amount: intent.amount,
      currency: 'TRY',
      callbackUrl: `${apiBase}/api/payments/${provider.name}/callback?ref=${encodeURIComponent(intent.conversationId)}`,
      buyer: {
        id: ctx.userId,
        // Karar C: TCKN yazilmaz; sandbox'ta veya verilmezse saglayicinin test numarasi.
        identityNumber: provider.sandbox || !input.identityNumber ? SANDBOX_IDENTITY_NUMBER : input.identityNumber,
        ip: meta.ip,
      },
      items: intent.allocations.map((a) => ({
        id: `${intentId}-${a.liableParty}`,
        name: `Aidat ödemesi · Daire ${data.unit.number} · ${PARTY_LABEL[a.liableParty]}`,
        amount: a.amount,
        subMerchantKey: intent.subMerchantKey,
        subMerchantPrice: a.subMerchantPrice,
      })),
    };

    let session;
    try {
      session = await provider.createCheckout(request);
    } catch (err) {
      const code = err instanceof PaymentProviderError ? err.code : 'provider_error';
      deps.log('error', 'checkout baslatilamadi', { intentId, apartmentId: ctx.apartmentId, code });
      await transition(intent, {
        status: 'FAILED',
        failure: { code, message: 'Ödeme sağlayıcısına ulaşılamadı', at: stamp() },
      });
      throw new PaymentsError('provider_unavailable', 'Ödeme sağlayıcısına şu an ulaşılamıyor, lütfen tekrar deneyin');
    }

    const started = await transition(intent, {
      checkout: { token: session.token, paymentPageUrl: session.paymentPageUrl, createdAt: stamp() },
    });
    return toView(started);
  }

  // ----- Durum gecisi -----

  /** Surum kosullu gecis; baska istek once davrandiysa guncel kaydi dondurur. */
  async function transition(intent: PaymentIntent, patch: Partial<PaymentIntent>): Promise<PaymentIntent> {
    const next: PaymentIntent = { ...intent, ...patch, updatedAt: stamp(), version: intent.version + 1 };
    try {
      await repo.updateIntent(next, intent.version);
      return next;
    } catch (err) {
      if (err instanceof PaymentsConflictError) {
        return (await repo.getIntent(intent.apartmentId, intent.intentId)) ?? intent;
      }
      throw err;
    }
  }

  /** Saglayici "basarili" dedi: sepet, tutar, para birimi ve fraud durumu niyetle birebir mi? */
  function verificationProblems(intent: PaymentIntent, o: CheckoutOutcome): string[] {
    const problems: string[] = [];
    if (!o.providerPaymentId) problems.push('providerPaymentId yok');
    if (o.basketId !== intent.intentId) problems.push(`basketId uyusmuyor (${o.basketId ?? '-'})`);
    if (o.conversationId !== intent.conversationId) problems.push('conversationId uyusmuyor');
    if (o.paidAmount !== intent.amount) problems.push(`tutar uyusmuyor (${o.paidAmount ?? '-'} != ${intent.amount})`);
    if (o.currency !== 'TRY') problems.push(`para birimi ${o.currency ?? '-'}`);
    if (o.fraudApproved === false) problems.push('fraud onayi yok');
    return problems;
  }

  /**
   * Odeme aninda kesinlesecek tazminatin ust siniri: niyetteki tutar ile alt carinin GUNCEL
   * defterine gore `lateFeeAsOf` itibariyla yazilmamis tazminatin kucugu. Niyet ile onay
   * arasinda aylik kesinlestirme calistiysa ayni tazminat iki kez yazilmaz; fark avans kalir.
   */
  async function lateFeeCap(intent: PaymentIntent, party: LiableParty, planned: Kurus): Promise<Kurus> {
    if (planned <= 0) return toKurus(0);
    const accountId = receivableAccountId(intent.unitId, party);
    const entries = (await deps.ledger.listLedgerEntries(intent.apartmentId, accountId)).filter(
      (e) => e.siteId === intent.apartmentId && e.accountId === accountId,
    );
    const ids = [...new Set(entries.map((e) => e.transactionId))];
    const txs = ids.length ? await deps.ledger.getTransactions(intent.apartmentId, ids) : [];
    const unposted = accruedLateFeeOf(
      entries,
      new Map(txs.map((t) => [t.transactionId, t])),
      intent.lateFeeMonthlyBasisPoints,
      intent.lateFeeAsOf,
    );
    return toKurus(Math.min(planned, unposted));
  }

  /** Saglayicidan sorgulanan sonucu niyete uygular (idempotent). */
  async function applyOutcome(intent: PaymentIntent, o: CheckoutOutcome): Promise<PaymentIntent> {
    if (intent.status !== 'PENDING' || o.status === 'pending') return intent;

    if (o.status === 'failure') {
      return transition(intent, {
        status: 'FAILED',
        failure: { code: o.errorCode ?? 'failed', message: o.errorMessage ?? 'Ödeme tamamlanamadı', at: stamp() },
      });
    }

    const problems = verificationProblems(intent, o);
    if (problems.length > 0) {
      deps.log('error', 'ALARM odeme incelemeye alindi (deftere yazilmadi)', {
        alert: 'PAYMENT_NEEDS_REVIEW',
        intentId: intent.intentId,
        apartmentId: intent.apartmentId,
        providerPaymentId: o.providerPaymentId,
        problems,
      });
      return transition(intent, {
        status: 'NEEDS_REVIEW',
        providerPaymentId: o.providerPaymentId,
        review: { reason: problems.join('; '), at: stamp(), providerPaymentId: o.providerPaymentId },
      });
    }

    const providerPaymentId = o.providerPaymentId as string;
    const paidAt = o.paidAt ?? today();
    const allocations = await Promise.all(
      intent.allocations.map(async (a) => ({
        liableParty: a.liableParty,
        amount: a.amount,
        lateFee: await lateFeeCap(intent, a.liableParty, a.lateFee),
      })),
    );

    try {
      await deps.finance.recordOnlinePayment(
        { apartmentId: intent.apartmentId, userId: intent.userId },
        {
          intentId: intent.intentId,
          unitId: intent.unitId,
          paidAt,
          provider: intent.provider,
          providerPaymentId,
          allocations,
          intentUpdate: ({ payments, transactions }) => ({
            item: {
              ...intent,
              status: 'SUCCEEDED',
              providerPaymentId,
              paidAt,
              paymentIds: payments.map((p) => p.paymentId),
              receiptNumbers: payments.map((p) => p.receiptNumber),
              transactionIds: transactions.map((t) => t.transactionId),
              updatedAt: stamp(),
              version: intent.version + 1,
            } satisfies PaymentIntent,
            expectedVersion: intent.version,
            label: 'intent',
          }),
        },
      );
    } catch (err) {
      // Niyet baska bir istekle (callback/webhook/mutabakat) sonuclandi: guncel hali doner.
      if (err instanceof LedgerConflictError && err.reason === 'precondition') {
        return (await repo.getIntent(intent.apartmentId, intent.intentId)) ?? intent;
      }
      // Gecici hata: niyet PENDING kalir, mutabakat tekrar dener.
      if (err instanceof DataAccessError && (err.code === 'throttled' || err.code === 'internal')) {
        deps.log('warn', 'tahsilat yazimi ertelendi', { intentId: intent.intentId, code: err.code });
        return intent;
      }
      // Belirleyici hata (ornegin daire silinmis): para tahsil edildi, elle incelenmeli.
      deps.log('error', 'ALARM tahsilat deftere yazilamadi', {
        alert: 'PAYMENT_NEEDS_REVIEW',
        intentId: intent.intentId,
        apartmentId: intent.apartmentId,
        providerPaymentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return transition(intent, {
        status: 'NEEDS_REVIEW',
        providerPaymentId,
        review: {
          reason: `defter yazimi basarisiz: ${err instanceof Error ? err.message : String(err)}`,
          at: stamp(),
          providerPaymentId,
        },
      });
    }
    return (await repo.getIntent(intent.apartmentId, intent.intentId)) ?? intent;
  }

  /** PENDING niyetin sonucunu saglayicidan sorgular ve uygular. */
  async function settle(intent: PaymentIntent): Promise<PaymentIntent> {
    if (intent.status !== 'PENDING' || !intent.checkout || !provider || provider.name !== intent.provider) return intent;
    let outcome: CheckoutOutcome;
    try {
      outcome = await provider.retrieveCheckout({ token: intent.checkout.token, conversationId: intent.conversationId });
    } catch (err) {
      deps.log('warn', 'saglayici sorgusu basarisiz', {
        intentId: intent.intentId,
        code: err instanceof PaymentProviderError ? err.code : 'unknown',
      });
      return intent;
    }
    return applyOutcome(intent, outcome);
  }

  // ----- Sakin: niyet durumu -----

  async function getIntent(ctx: PaymentsContext, intentId: string, options: { refresh?: boolean } = {}) {
    assertId(intentId, 'intentId');
    const intent = await repo.getIntent(ctx.apartmentId, intentId);
    // Baskasinin niyeti ile hic olmayan niyet ayni yaniti alir.
    if (!intent || intent.userId !== ctx.userId || intent.apartmentId !== ctx.apartmentId) {
      throw new PaymentsError('not_found', 'Ödeme bulunamadı');
    }
    return toView(options.refresh ? await settle(intent) : intent);
  }

  // ----- Saglayici callback'i (kimliksiz; tarayici POST eder) -----

  const resultUrl = (params: Record<string, string>) =>
    `${webBase}/portal/odeme/sonuc?${new URLSearchParams(params).toString()}`;

  /**
   * Kimlik dogrulamasi yoktur; guven, sonucun saglayicidan token ile SORGULANMASINDAN ve
   * niyetle birebir eslesmesinden gelir. Yanit her durumda web uygulamasina yonlendirmedir.
   */
  async function handleCallback(providerName: string, input: { ref?: string; token?: string }): Promise<{ redirectUrl: string; intent?: PaymentIntent }> {
    const m = REF.exec(input.ref ?? '');
    if (!provider || provider.name !== providerName || !m || !input.token || input.token.length > 512) {
      deps.log('warn', 'gecersiz callback', { providerName, hasRef: Boolean(input.ref), hasToken: Boolean(input.token) });
      return { redirectUrl: resultUrl({ error: 'invalid' }) };
    }
    const [, apartmentId, intentId] = m as unknown as [string, string, string];
    const intent = await repo.getIntent(apartmentId, intentId);
    if (!intent) return { redirectUrl: resultUrl({ error: 'not_found' }) };
    if (!intent.checkout || intent.checkout.token !== input.token) {
      deps.log('warn', 'callback token niyetle eslesmiyor', { intentId, apartmentId });
      return { redirectUrl: resultUrl({ intent: intentId }), intent };
    }
    const settled = await settle(intent);
    return { redirectUrl: resultUrl({ intent: intentId }), intent: settled };
  }

  // ----- Mutabakat (zamanlanmis gorev) -----

  /**
   * Kaybolan callback'leri yakalar: `RECONCILE_GRACE_MINUTES`'tan eski PENDING niyetleri
   * saglayicidan sorgular. Odeme sayfasi hic acilmamis veya saglayici uzun suredir "pending"
   * diyorsa niyet FAILED olur. Niyetin suresi gecmis olsa da saglayici basarili diyorsa YAZILIR
   * (para tahsil edilmistir).
   */
  async function reconcile(apartmentId: string) {
    const now = deps.now();
    const from = utcStamp(new Date(now.getTime() - RECONCILE_LOOKBACK_DAYS * 86_400_000));
    const to = `${utcStamp(new Date(now.getTime() - RECONCILE_GRACE_MINUTES * 60_000))}~`;
    const pending = (await repo.listIntentsBetween(apartmentId, from, to)).filter((i) => i.status === 'PENDING');
    const result = { checked: pending.length, succeeded: 0, failed: 0, review: 0, stillPending: 0 };
    for (const intent of pending) {
      let current = intent;
      if (intent.checkout) current = await settle(intent);
      const giveUpAt = Date.parse(intent.createdAt) + PENDING_GIVE_UP_HOURS * 3_600_000;
      const neverStarted = !intent.checkout && now.getTime() > Date.parse(intent.expiresAt);
      if (current.status === 'PENDING' && (neverStarted || now.getTime() > giveUpAt)) {
        current = await transition(current, {
          status: 'FAILED',
          failure: { code: 'expired', message: 'Ödeme süresi doldu', at: stamp() },
        });
      }
      if (current.status === 'SUCCEEDED') result.succeeded++;
      else if (current.status === 'FAILED') result.failed++;
      else if (current.status === 'NEEDS_REVIEW') result.review++;
      else result.stillPending++;
    }
    return result;
  }

  return { provider, quote, createIntent, getIntent, handleCallback, reconcile };
}

export type PaymentsService = ReturnType<typeof createPaymentsService>;
