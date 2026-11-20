import { createHash, randomUUID } from 'node:crypto';
import type { Role } from '../../auth/claims.js';
import { DataAccessError } from '../../config/dynamodb.js';
import { type IsoDate, type IsoDateTime, type Kurus, type LiableParty, toKurus } from '../core/types.js';
import { ValidationError, asObject, assertId } from '../core/validation.js';
import { LedgerConflictError } from '../finance/repository.js';
import type { FinanceService } from '../finance/service.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import type { PortalRepository } from '../portal/repository.js';
import type { PortalService } from '../portal/service.js';
import { type PersonRepository, personRepository } from '../residents/repository.js';
import {
  type CheckoutBuyer,
  type CheckoutOutcome,
  type CheckoutRequest,
  type PaymentProvider,
  PaymentProviderError,
  SANDBOX_GSM_NUMBER,
  SANDBOX_IDENTITY_NUMBER,
  type SubMerchantRequest,
  type WebhookInput,
} from './provider.js';
import {
  type PaymentSelection,
  accruedLateFeeOf,
  allocateSelection,
  buildQuote,
  receivableAccountId,
} from './quote.js';
import {
  InvalidIntentCursorError,
  type PaymentsRepository,
  PaymentsConflictError,
  paymentKeys,
  paymentsRepository,
  toStoredIntent,
} from './repository.js';
import {
  INTENT_STATUSES,
  type IntentKeyRecord,
  type IntentStatus,
  MAX_PLATFORM_FEE_BASIS_POINTS,
  PAYMENT_MODES,
  type PaymentAccount,
  type PaymentIntent,
  type PaymentMode,
  type ProviderCheck,
  REVIEW_ACTIONS,
  type RefundItem,
  type ReviewAction,
  SUB_MERCHANT_TYPES,
  type SubMerchantType,
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
  | 'profile_incomplete'
  | 'provider_rejected'
  | 'provider_unavailable'
  | 'action_not_allowed'
  | 'ledger_failed';

const STATUS: Record<PaymentsErrorCode, 404 | 409 | 422 | 502> = {
  not_found: 404,
  no_debt: 422,
  payments_disabled: 422,
  idempotency_conflict: 409,
  conflict: 409,
  profile_incomplete: 422,
  provider_rejected: 422,
  provider_unavailable: 502,
  action_not_allowed: 422,
  ledger_failed: 422,
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
/** Alt uye isyeri (KYC) kaydi yalnizca platform ekibi tarafindan yapilir. */
export const PAYMENT_ADMIN_ROLES: readonly Role[] = ['platform_admin'];
/** Apartmanin online odemelerini goren roller (finans okuma rolleriyle ayni; salt okunur). */
export const PAYMENT_MANAGER_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];

/** Odeme sonrasi donus sayfasi (web: sakin rotalari /app altinda). */
export const PAYMENT_RESULT_PATH = '/app/odeme/sonuc';
const MAX_INTENT_PAGE = 100;

export type PaymentsContext = { apartmentId: string; userId: string; role: Role };

export type PaymentsLog = (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;

export type PaymentsServiceDeps = {
  repository: PaymentsRepository;
  /** Odenebilir borc: portalin erisim kurallari (rol, aktif uyelik, uyelik donemi). */
  portal: Pick<PortalService, 'getPayableLedgers'>;
  /** Sonuclandirmada tazminat ust siniri icin alt carinin TUM satirlari (uyelikten bagimsiz). */
  ledger: Pick<PortalRepository, 'listLedgerEntries' | 'getTransactions'>;
  finance: Pick<FinanceService, 'recordOnlinePayment'>;
  /** Alici adi/e-postasi (sakin dizini, `PERSON#`) ve apartman adresi. */
  people: Pick<PersonRepository, 'get'>;
  core: Pick<CoreRepository, 'getSite' | 'listSiteIds'>;
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
/**
 * Sonucu belirsiz kalan (zaman asimi) bir iade denemesinden sonra bu sure gecmeden tekrar
 * denenmez: devam eden bir cagri ile yarisip ayni kalemi iki kez iade etmemek icin.
 */
export const REFUND_RETRY_MINUTES = 5;
const MAX_REVIEW_QUEUE = 200;
const NOTE_MIN = 5;
const NOTE_MAX = 500;

const LIABLE_PARTIES = ['owner', 'occupant'] as const;
const PARTY_LABEL: Record<LiableParty, string> = { owner: 'Kat Maliki', occupant: 'Sakin' };
const MAX_SELECTED_ITEMS = 120;
const REF = /^([A-Za-z0-9_-]{1,64}):(\d{14}-[A-Za-z0-9_-]{1,64})$/;
const TCKN = /^[1-9]\d{10}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "0532 123 45 67", "5321234567", "+90 532..." -> "+905321234567"; gecersizse undefined. */
export function normalizeGsm(value: string): string | undefined {
  const digits = value.replace(/[\s()-]/g, '');
  const m = /^(?:\+?90|0)?(5\d{9})$/.exec(digits);
  return m ? `+90${m[1]}` : undefined;
}

/** TR IBAN: TR + 24 hane, ISO 13616 mod-97 kontrolu. */
export function isValidTrIban(value: string): boolean {
  const iban = value.replace(/\s/g, '').toUpperCase();
  if (!/^TR\d{24}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rem = 0;
  for (const d of numeric) rem = (rem * 10 + Number(d)) % 97;
  return rem === 1;
}

/** Yalnizca son 4 hane: "TR** **** **** **** **** **12 34". */
export function maskIban(value: string): string {
  const iban = value.replace(/\s/g, '').toUpperCase();
  const last4 = iban.slice(-4);
  return `TR** **** **** **** **** **${last4.slice(0, 2)} ${last4.slice(2)}`;
}

/** "Ayşe Nur Yılmaz" -> { name: "Ayşe Nur", surname: "Yılmaz" } */
function splitFullName(fullName: string): { name: string; surname: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return { name: parts[0] ?? '', surname: parts[0] ?? '' };
  return { name: parts.slice(0, -1).join(' '), surname: parts.at(-1) as string };
}

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
    ...(i.status === 'REFUND_PENDING'
      ? { failureMessage: 'Ödemeniz borcunuza işlenemedi; tutarın tamamı kartınıza iade ediliyor.' }
      : {}),
    ...(i.status === 'REFUNDED'
      ? { failureMessage: 'Ödemeniz borcunuza işlenemedi ve tutarın tamamı kartınıza iade edildi. İadenin hesabınıza yansıması bankanıza göre birkaç gün sürebilir.' }
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
  /** TCKN ve telefon saklanmaz; yalnizca saglayici istegine gider (Karar C). */
  identityNumber?: string;
  gsmNumber?: string;
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
  let gsmNumber: string | undefined;
  if (o.gsmNumber !== undefined && o.gsmNumber !== null && o.gsmNumber !== '') {
    gsmNumber = typeof o.gsmNumber === 'string' ? normalizeGsm(o.gsmNumber) : undefined;
    if (!gsmNumber) throw new ValidationError('gsmNumber geçerli bir cep telefonu numarası olmalıdır (05xx...)', 'gsmNumber');
  }
  return { idempotencyKey, unitId, selection, identityNumber, gsmNumber };
}

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

export function createPaymentsService(overrides: Partial<PaymentsServiceDeps> & Pick<PaymentsServiceDeps, 'portal' | 'ledger' | 'finance'>) {
  const deps: PaymentsServiceDeps = {
    repository: paymentsRepository,
    people: personRepository,
    core: coreRepository,
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

  /**
   * Saglayiciya giden alici: ad/e-posta sakin dizininden (`PERSON#`), adres apartmanin
   * adresinden; TCKN ve telefon istekten (saklanmaz). Sandbox'ta eksikler test degerleriyle
   * doldurulur; canlida eksik bilgi 422/400 ile reddedilir (yarim niyet olusmaz).
   */
  async function resolveBuyer(ctx: PaymentsContext, input: IntentInput, ip: string, sandbox: boolean): Promise<CheckoutBuyer> {
    const [person, site] = await Promise.all([
      deps.people.get(ctx.apartmentId, ctx.userId),
      deps.core.getSite(ctx.apartmentId),
    ]);
    const valid = person && person.userId === ctx.userId && person.apartmentId === ctx.apartmentId ? person : undefined;
    if (!valid && !sandbox) {
      throw new PaymentsError('profile_incomplete', 'Ödeme için ad ve e-posta bilginiz eksik; lütfen yönetiminizle iletişime geçin');
    }
    const gsmNumber = input.gsmNumber ?? (sandbox ? SANDBOX_GSM_NUMBER : undefined);
    if (!gsmNumber) throw new ValidationError('Ödeme için cep telefonu numarası gereklidir', 'gsmNumber');
    const { name, surname } = splitFullName(valid?.fullName ?? 'Test Sakin');
    const address = site ? [site.address.line1, site.address.line2, site.address.district].filter(Boolean).join(', ') : '';
    return {
      id: ctx.userId,
      // Karar C: sandbox'ta veya verilmezse saglayicinin test numarasi.
      identityNumber: sandbox || !input.identityNumber ? SANDBOX_IDENTITY_NUMBER : input.identityNumber,
      ip,
      name,
      surname,
      email: valid?.email ?? 'sandbox@example.com',
      gsmNumber,
      address: address || 'Türkiye',
      city: site?.address.city ?? 'Istanbul',
    };
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
    return {
      unitId: data.unit.unitId,
      currency: 'TRY' as const,
      onlinePaymentEnabled: Boolean(account),
      // Canli saglayicida telefon zorunlu; sandbox'ta test degeri kullanilir (alan gizlenir).
      requiresGsmNumber: Boolean(provider && !provider.sandbox),
      ...q,
    };
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
    // Alici bilgisi niyet yazilmadan once: eksikse yarim kalmis niyet olusmaz.
    const buyer = await resolveBuyer(ctx, input, meta.ip, provider.sandbox);

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
      buyer,
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
    if (o.signatureValid === false) problems.push('yanit imzasi dogrulanamadi');
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

  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const isTransient = (err: unknown) => err instanceof DataAccessError && (err.code === 'throttled' || err.code === 'internal');

  /**
   * Dogrulanmis basarili sonucu deftere yazar: tazminat ust siniri yeniden hesaplanir, tahsilat +
   * makbuz + niyetin SUCCEEDED hali tek atomik yazimdir (`pay-<intentId>` mukerrer yazimi engeller).
   * Niyet surumu degismisse `LedgerConflictError(precondition)` firlatir.
   */
  async function writeLedger(intent: PaymentIntent, o: CheckoutOutcome, extra: Partial<PaymentIntent> = {}): Promise<void> {
    const providerPaymentId = o.providerPaymentId as string;
    const paidAt = o.paidAt ?? today();
    const allocations = await Promise.all(
      intent.allocations.map(async (a) => ({
        liableParty: a.liableParty,
        amount: a.amount,
        lateFee: await lateFeeCap(intent, a.liableParty, a.lateFee),
      })),
    );
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
          // Inceleme kuyrugu alanlari durumdan turetilir: SUCCEEDED kayit kuyruktan duser.
          item: toStoredIntent({
            ...intent,
            ...extra,
            status: 'SUCCEEDED',
            providerPaymentId,
            itemTransactions: o.itemTransactions ?? intent.itemTransactions,
            paidAt,
            paymentIds: payments.map((p) => p.paymentId),
            receiptNumbers: payments.map((p) => p.receiptNumber),
            transactionIds: transactions.map((t) => t.transactionId),
            updatedAt: stamp(),
            version: intent.version + 1,
          } satisfies PaymentIntent),
          expectedVersion: intent.version,
          label: 'intent',
        }),
      },
    );
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
        itemTransactions: o.itemTransactions,
        review: { reason: problems.join('; '), at: stamp(), providerPaymentId: o.providerPaymentId },
      });
    }

    try {
      await writeLedger(intent, o);
    } catch (err) {
      // Niyet baska bir istekle (callback/webhook/mutabakat) sonuclandi: guncel hali doner.
      if (err instanceof LedgerConflictError && err.reason === 'precondition') {
        return (await repo.getIntent(intent.apartmentId, intent.intentId)) ?? intent;
      }
      // Gecici hata: niyet PENDING kalir, mutabakat tekrar dener.
      if (isTransient(err)) {
        deps.log('warn', 'tahsilat yazimi ertelendi', { intentId: intent.intentId, code: (err as DataAccessError).code });
        return intent;
      }
      // Belirleyici hata (ornegin daire silinmis): para tahsil edildi, elle incelenmeli.
      const providerPaymentId = o.providerPaymentId as string;
      deps.log('error', 'ALARM tahsilat deftere yazilamadi', {
        alert: 'PAYMENT_NEEDS_REVIEW',
        intentId: intent.intentId,
        apartmentId: intent.apartmentId,
        providerPaymentId,
        error: errText(err),
      });
      return transition(intent, {
        status: 'NEEDS_REVIEW',
        providerPaymentId,
        itemTransactions: o.itemTransactions,
        review: { reason: `defter yazimi basarisiz: ${errText(err)}`, at: stamp(), providerPaymentId },
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
    `${webBase}${PAYMENT_RESULT_PATH}?${new URLSearchParams(params).toString()}`;

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

  // ----- Saglayici webhook'u (kimliksiz, imzali; sunucudan sunucuya) -----

  /**
   * Imza dogrulanirsa ilgili niyet saglayicidan SORGULANARAK sonuclandirilir (webhook
   * govdesindeki durum kullanilmaz). Bilinmeyen niyet icin de 200 doner: saglayici tekrar
   * denemeyi birakir. Gecersiz imza 401.
   */
  async function handleWebhook(providerName: string, input: WebhookInput): Promise<{ status: 200 | 401 | 404 | 503 }> {
    if (!provider || provider.name !== providerName || !provider.verifyWebhook) return { status: 404 };
    let verified: { conversationId: string } | null;
    try {
      verified = await provider.verifyWebhook(input);
    } catch (err) {
      deps.log('error', 'webhook dogrulanamadi (anahtar okunamadi)', { code: err instanceof PaymentProviderError ? err.code : 'unknown' });
      return { status: 503 };
    }
    if (!verified) {
      deps.log('warn', 'webhook imzasi gecersiz', { providerName });
      return { status: 401 };
    }
    const m = REF.exec(verified.conversationId);
    if (!m) {
      deps.log('warn', 'webhook bilinmeyen conversationId', { providerName });
      return { status: 200 };
    }
    const [, apartmentId, intentId] = m as unknown as [string, string, string];
    const intent = await repo.getIntent(apartmentId, intentId);
    if (intent) await settle(intent);
    return { status: 200 };
  }

  // ----- Platform: NEEDS_REVIEW elle sonuclandirma (deftere yaz / tam iade / kapat) -----

  /** Saglayicidan guncel sonucu sorgular; sonuclandirma kararlari yalnizca buna dayanir. */
  async function providerCheck(intent: PaymentIntent): Promise<{ check: ProviderCheck; outcome?: CheckoutOutcome }> {
    if (!provider || provider.name !== intent.provider || !intent.checkout) {
      throw new PaymentsError('payments_disabled', 'Bu ödemenin sağlayıcısı şu an yapılandırılmamış');
    }
    let o: CheckoutOutcome;
    try {
      o = await provider.retrieveCheckout({ token: intent.checkout.token, conversationId: intent.conversationId });
    } catch (err) {
      deps.log('warn', 'inceleme: saglayici sorgusu basarisiz', { intentId: intent.intentId, code: err instanceof PaymentProviderError ? err.code : 'unknown' });
      throw new PaymentsError('provider_unavailable', 'Ödeme sağlayıcısına şu an ulaşılamıyor, lütfen tekrar deneyin');
    }
    return {
      outcome: o,
      check: {
        status: o.status,
        providerPaymentId: o.providerPaymentId,
        paidAmount: o.paidAmount,
        currency: o.currency,
        fraudApproved: o.fraudApproved,
        problems: o.status === 'success' ? verificationProblems(intent, o) : [],
        errorMessage: o.errorMessage,
        checkedAt: stamp(),
      },
    };
  }

  /**
   * Iade, yalnizca odemenin bu niyete ait oldugu kanitlanabiliyorsa (sepet ve conversationId
   * eslesiyor) ve kalem islem kimlikleri biliniyorsa yapilabilir; aksi halde saglayici panelinden.
   */
  function refundBlocker(intent: PaymentIntent, o: CheckoutOutcome | undefined): string | undefined {
    if (!o || o.status !== 'success') return 'Sağlayıcıda başarılı çekim yok';
    if (!o.providerPaymentId) return 'Sağlayıcı ödeme numarası yok';
    if (o.basketId !== intent.intentId || o.conversationId !== intent.conversationId) {
      return 'Ödeme bu kayıtla eşleşmiyor; iadeyi sağlayıcı panelinden yapın';
    }
    const items = o.itemTransactions ?? [];
    if (items.length === 0 || items.some((t) => !t.paymentTransactionId || t.paidAmount < 1)) {
      return 'Kalem işlem numaraları alınamadı; iadeyi sağlayıcı panelinden yapın';
    }
    return undefined;
  }

  type ActionView = { action: ReviewAction; allowed: boolean; reason?: string };

  function actionsFor(intent: PaymentIntent, o: CheckoutOutcome | undefined, check: ProviderCheck | undefined): ActionView[] {
    if (intent.status === 'REFUND_PENDING') {
      const open = intent.refund?.items.some((i) => i.status !== 'succeeded') ?? false;
      return [
        { action: 'approve', allowed: false, reason: 'İade kararı verildi' },
        { action: 'refund', allowed: open, reason: open ? undefined : 'Tüm kalemler iade edildi' },
        { action: 'close', allowed: false, reason: 'İade kararı verildi' },
      ];
    }
    if (intent.status !== 'NEEDS_REVIEW' || !check) {
      return REVIEW_ACTIONS.map((action) => ({ action, allowed: false, reason: 'Ödeme inceleme beklemiyor' }));
    }
    const pending = check.status === 'pending' ? 'Sağlayıcıda sonuç henüz kesinleşmedi' : undefined;
    const approveReason =
      pending ??
      (check.status !== 'success'
        ? 'Sağlayıcıda başarılı çekim yok'
        : check.problems.length > 0
          ? `Doğrulama tutmuyor: ${check.problems.join('; ')}`
          : undefined);
    const refundReason = pending ?? refundBlocker(intent, o);
    const closeReason = pending ?? (check.status === 'success' ? 'Sağlayıcıda başarılı çekim var; deftere işleyin veya iade edin' : undefined);
    return [
      { action: 'approve', allowed: !approveReason, reason: approveReason },
      { action: 'refund', allowed: !refundReason, reason: refundReason },
      { action: 'close', allowed: !closeReason, reason: closeReason },
    ];
  }

  /** Platform gorunumu: yonetici gorunumu + iz kaydi + iade kalemleri + surum (iyimser kilit). */
  function reviewView(i: PaymentIntent) {
    return {
      ...managerView(i),
      apartmentId: i.apartmentId,
      version: i.version,
      resolution: i.resolution,
      refund: i.refund,
    };
  }

  async function loadForReview(apartmentId: string, intentId: string): Promise<PaymentIntent> {
    assertId(apartmentId, 'apartmentId');
    assertId(intentId, 'intentId');
    const intent = await repo.getIntent(apartmentId, intentId);
    if (!intent || intent.apartmentId !== apartmentId) throw new PaymentsError('not_found', 'Ödeme bulunamadı');
    return intent;
  }

  /** Platform: tum apartmanlarda inceleme bekleyen / iadesi suren odemeler (en eski once). */
  async function listReviewQueue() {
    const intents = await repo.listReviewQueue(MAX_REVIEW_QUEUE);
    const names = new Map<string, string>();
    await Promise.all(
      [...new Set(intents.map((i) => i.apartmentId))].map(async (id) => {
        const site = await deps.core.getSite(id);
        if (site) names.set(id, site.name);
      }),
    );
    return { items: intents.map((i) => ({ ...reviewView(i), apartmentName: names.get(i.apartmentId) ?? i.apartmentId })) };
  }

  /** Platform: saglayicidan guncel sonuc + hangi islemlerin yapilabilecegi (karar oncesi). */
  async function checkReview(apartmentId: string, intentId: string) {
    const intent = await loadForReview(apartmentId, intentId);
    if (intent.status === 'REFUND_PENDING') return { intent: reviewView(intent), check: null, actions: actionsFor(intent, undefined, undefined) };
    if (intent.status !== 'NEEDS_REVIEW') {
      return { intent: reviewView(intent), check: null, actions: actionsFor(intent, undefined, undefined) };
    }
    const { check, outcome } = await providerCheck(intent);
    return { intent: reviewView(intent), check, actions: actionsFor(intent, outcome, check) };
  }

  function parseResolveInput(body: unknown): { action: ReviewAction; note: string; expectedVersion: number } {
    const o = asObject(body);
    if (typeof o.action !== 'string' || !(REVIEW_ACTIONS as readonly string[]).includes(o.action)) {
      throw new ValidationError(`action şu değerlerden biri olmalıdır: ${REVIEW_ACTIONS.join(', ')}`, 'action');
    }
    const note = typeof o.note === 'string' ? o.note.trim() : '';
    if (note.length < NOTE_MIN || note.length > NOTE_MAX) {
      throw new ValidationError(`Gerekçe ${NOTE_MIN}-${NOTE_MAX} karakter olmalıdır`, 'note');
    }
    const v = o.expectedVersion;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new ValidationError('expectedVersion zorunludur', 'expectedVersion');
    return { action: o.action as ReviewAction, note, expectedVersion: v };
  }

  /**
   * Platform: inceleme bekleyen odemeyi sonuclandirir. Karar her zaman saglayicidan YENIDEN
   * sorgulanan sonuca gore dogrulanir (ekrandaki eski kontrole guvenilmez); surum degismisse 409.
   */
  async function resolveReview(ctx: { userId: string }, apartmentId: string, intentId: string, body: unknown, meta: { ip: string }) {
    const input = parseResolveInput(body);
    const intent = await loadForReview(apartmentId, intentId);
    if (intent.version !== input.expectedVersion) {
      throw new PaymentsError('conflict', 'Ödeme kaydı siz incelerken değişti; sayfayı yenileyip tekrar kontrol edin');
    }

    // Iade suruyor: yalnizca kalan/basarisiz kalemleri tekrar dene.
    if (intent.status === 'REFUND_PENDING') {
      if (input.action !== 'refund') throw new PaymentsError('action_not_allowed', 'Bu ödeme için iade kararı verildi');
      deps.log('info', 'AUDIT iade yeniden denendi', { audit: 'PAYMENT_REFUND_RETRIED', apartmentId, intentId, by: ctx.userId, note: input.note });
      return { intent: reviewView(await processRefund(intent, { ip: meta.ip, retryFailed: true })) };
    }
    if (intent.status !== 'NEEDS_REVIEW') throw new PaymentsError('action_not_allowed', 'Ödeme inceleme beklemiyor');

    const { check, outcome } = await providerCheck(intent);
    const verdict = actionsFor(intent, outcome, check).find((a) => a.action === input.action) as ActionView;
    if (!verdict.allowed) throw new PaymentsError('action_not_allowed', verdict.reason ?? 'Bu işlem yapılamaz');
    const resolution: PaymentIntent['resolution'] = { action: input.action, note: input.note, by: ctx.userId, at: stamp(), providerCheck: check };
    const auditFields = {
      apartmentId,
      intentId,
      by: ctx.userId,
      action: input.action,
      note: input.note,
      providerPaymentId: check.providerPaymentId,
      amount: intent.amount,
    };
    const o = outcome as CheckoutOutcome;

    if (input.action === 'approve') {
      try {
        await writeLedger(intent, o, { resolution });
      } catch (err) {
        if (err instanceof LedgerConflictError && err.reason === 'precondition') {
          throw new PaymentsError('conflict', 'Ödeme kaydı eş zamanlı olarak değişti; sayfayı yenileyin');
        }
        deps.log('error', 'inceleme: deftere yazilamadi', { ...auditFields, error: errText(err) });
        if (isTransient(err)) throw new PaymentsError('provider_unavailable', 'Kayıt şu an yazılamadı, lütfen tekrar deneyin');
        throw new PaymentsError('ledger_failed', `Deftere yazılamadı: ${errText(err)}. Ödemeyi iade edebilirsiniz.`);
      }
      deps.log('info', 'AUDIT inceleme sonuclandi: deftere yazildi', { audit: 'PAYMENT_REVIEW_RESOLVED', ...auditFields });
      return { intent: reviewView((await repo.getIntent(apartmentId, intentId)) ?? intent) };
    }

    if (input.action === 'close') {
      const next = await strictTransition(intent, {
        status: 'FAILED',
        failure: { code: 'review_closed', message: 'Ödeme sağlayıcıda tamamlanmamış; kayıt kapatıldı', at: stamp() },
        resolution,
      });
      deps.log('info', 'AUDIT inceleme sonuclandi: kapatildi', { audit: 'PAYMENT_REVIEW_RESOLVED', ...auditFields });
      return { intent: reviewView(next) };
    }

    // refund: once karar yazilir (REFUND_PENDING), sonra kalemler iade edilir.
    const itemTransactions = o.itemTransactions ?? [];
    const items: RefundItem[] = itemTransactions.map((t, idx) => ({
      paymentTransactionId: t.paymentTransactionId,
      itemId: t.itemId,
      amount: t.paidAmount,
      conversationId: `refund-${intent.intentId}-${idx + 1}`,
      status: 'pending',
      attempts: 0,
    }));
    const decided = await strictTransition(intent, {
      status: 'REFUND_PENDING',
      providerPaymentId: o.providerPaymentId,
      itemTransactions,
      resolution,
      refund: { items, requestedAt: stamp(), requestedBy: ctx.userId },
    });
    deps.log('info', 'AUDIT inceleme sonuclandi: tam iade karari', {
      audit: 'PAYMENT_REVIEW_RESOLVED',
      ...auditFields,
      refundAmount: items.reduce((sum, i) => sum + i.amount, 0),
    });
    return { intent: reviewView(await processRefund(decided, { ip: meta.ip, retryFailed: false })) };
  }

  /** `transition` gibi, ama baska bir istek once davrandiysa 409 (elle kararlar sessizce ezilmez). */
  async function strictTransition(intent: PaymentIntent, patch: Partial<PaymentIntent>): Promise<PaymentIntent> {
    const next: PaymentIntent = { ...intent, ...patch, updatedAt: stamp(), version: intent.version + 1 };
    try {
      await repo.updateIntent(next, intent.version);
      return next;
    } catch (err) {
      if (err instanceof PaymentsConflictError) {
        throw new PaymentsError('conflict', 'Ödeme kaydı eş zamanlı olarak değişti; sayfayı yenileyin');
      }
      throw err;
    }
  }

  /**
   * REFUND_PENDING niyetin kalemlerini sirayla iade eder. Her deneme once niyete surum kosullu
   * yazilir (`attemptedAt`): es zamanli ikinci bir islem kosulu tutturamaz ve cekilir. Daha once
   * denenmis (sonucu belirsiz) bir kalem, saglayicida iade edilmis tutar sorgulanmadan tekrar
   * gonderilmez; boylece ayni kalem iki kez iade edilmez. Tum kalemler tamamlaninca REFUNDED.
   */
  async function processRefund(start: PaymentIntent, opts: { ip: string; retryFailed: boolean }): Promise<PaymentIntent> {
    let intent = start;
    if (!provider || provider.name !== intent.provider || !intent.refund) return intent;
    const nowMs = () => deps.now().getTime();

    for (let idx = 0; idx < intent.refund!.items.length; idx++) {
      const item = intent.refund!.items[idx] as RefundItem;
      if (item.status === 'succeeded') continue;
      if (item.status === 'failed' && !opts.retryFailed) continue;
      const recent = item.attemptedAt && nowMs() - Date.parse(item.attemptedAt) < REFUND_RETRY_MINUTES * 60_000;
      if (item.status === 'pending' && recent) continue; // devam eden olasi bir cagri ile yarisma

      const uncertain = item.attempts > 0 && item.status === 'pending';
      // 1) Deneme hakki: surum kosullu yazim.
      const claimed = await withItem(intent, idx, { status: 'pending', attemptedAt: stamp(), attempts: item.attempts + 1, error: undefined });
      if (!claimed) return (await repo.getIntent(intent.apartmentId, intent.intentId)) ?? intent;
      intent = claimed;

      // 2) Sonucu belirsiz onceki deneme: saglayicida zaten iade edilmis mi?
      if (uncertain) {
        try {
          const refunded = await provider.refundedAmounts({ providerPaymentId: intent.providerPaymentId as string, conversationId: intent.conversationId });
          if ((refunded.get(item.paymentTransactionId) ?? 0) >= item.amount) {
            const done = await withItem(intent, idx, { status: 'succeeded', completedAt: stamp() });
            if (!done) return (await repo.getIntent(intent.apartmentId, intent.intentId)) ?? intent;
            intent = done;
            continue;
          }
        } catch (err) {
          // Durum bilinemiyorsa tekrar gonderilmez; sonraki mutabakatta yeniden sorulur.
          deps.log('warn', 'iade durumu sorgulanamadi', { intentId: intent.intentId, code: err instanceof PaymentProviderError ? err.code : 'unknown' });
          continue;
        }
      }

      // 3) Iade cagrisi.
      let patch: Partial<RefundItem>;
      try {
        const r = await provider.refundItem({
          paymentTransactionId: item.paymentTransactionId,
          amount: item.amount,
          conversationId: item.conversationId,
          ip: opts.ip,
        });
        patch = { status: 'succeeded', providerRefundId: r.providerRefundId, completedAt: stamp() };
      } catch (err) {
        const code = err instanceof PaymentProviderError ? err.code : 'unknown';
        const message = errText(err);
        if (err instanceof PaymentProviderError && !err.retryable) {
          deps.log('error', 'ALARM iade saglayici tarafindan reddedildi', {
            alert: 'PAYMENT_REFUND_FAILED',
            intentId: intent.intentId,
            apartmentId: intent.apartmentId,
            paymentTransactionId: item.paymentTransactionId,
            code,
            message,
          });
          patch = { status: 'failed', error: { code, message, at: stamp() } };
        } else {
          // Sonuc belirsiz: `attemptedAt` dolu kalir; tekrar denemeden once durum sorgulanir.
          deps.log('warn', 'iade sonucu belirsiz, tekrar denenecek', { intentId: intent.intentId, code });
          patch = { status: 'pending', error: { code, message, at: stamp() } };
        }
      }
      const saved = await withItem(intent, idx, patch);
      if (!saved) return (await repo.getIntent(intent.apartmentId, intent.intentId)) ?? intent;
      intent = saved;
    }

    if (intent.refund!.items.every((i) => i.status === 'succeeded') && intent.status === 'REFUND_PENDING') {
      const done = await transition(intent, { status: 'REFUNDED', refund: { ...intent.refund!, completedAt: stamp() } });
      if (done.status === 'REFUNDED') {
        deps.log('info', 'AUDIT iade tamamlandi', {
          audit: 'PAYMENT_REFUNDED',
          apartmentId: done.apartmentId,
          intentId: done.intentId,
          amount: done.refund!.items.reduce((sum, i) => sum + i.amount, 0),
        });
      }
      return done;
    }
    return intent;
  }

  /** Tek iade kalemini gunceller (surum kosullu); baska istek once davrandiysa undefined. */
  async function withItem(intent: PaymentIntent, idx: number, patch: Partial<RefundItem>): Promise<PaymentIntent | undefined> {
    const items = intent.refund!.items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    const next: PaymentIntent = { ...intent, refund: { ...intent.refund!, items }, updatedAt: stamp(), version: intent.version + 1 };
    try {
      await repo.updateIntent(next, intent.version);
      return next;
    } catch (err) {
      if (err instanceof PaymentsConflictError) return undefined;
      throw err;
    }
  }

  /**
   * Mutabakat (zamanlanmis gorev, apartmandan bagimsiz): iadesi suren niyetlerin bekleyen
   * kalemlerini tekrar dener. Reddedilmis kalemler yalnizca platform ekibinin karariyla denenir.
   */
  async function reconcileRefunds() {
    const queue = (await repo.listReviewQueue(MAX_REVIEW_QUEUE)).filter((i) => i.status === 'REFUND_PENDING');
    const result = { checked: queue.length, refunded: 0, stillPending: 0 };
    for (const intent of queue) {
      const next = await processRefund(intent, { ip: '127.0.0.1', retryFailed: false });
      if (next.status === 'REFUNDED') result.refunded++;
      else result.stillPending++;
    }
    return result;
  }

  // ----- Platform: alt uye isyeri (Karar 1) -----

  function accountView(a: PaymentAccount) {
    const { PK: _pk, SK: _sk, ...rest } = a;
    return rest;
  }

  async function requireSite(apartmentId: string) {
    assertId(apartmentId, 'apartmentId');
    const site = await deps.core.getSite(apartmentId);
    if (!site) throw new PaymentsError('not_found', 'Apartman bulunamadı');
    return site;
  }

  async function getAccount(apartmentId: string) {
    await requireSite(apartmentId);
    if (!provider) throw new PaymentsError('payments_disabled', 'Online ödeme yapılandırılmamış');
    const account = await repo.getAccount(apartmentId, provider.name);
    if (!account) throw new PaymentsError('not_found', 'Bu apartman için alt üye işyeri kaydı yok');
    return accountView(account);
  }

  function parseSubMerchant(apartmentId: string, body: unknown): { request: SubMerchantRequest; feeBps: number } {
    const o = asObject(body);
    const str = (key: string, min: number, max: number, required: boolean): string | undefined => {
      const v = o[key];
      if (v === undefined || v === null || v === '') {
        if (required) throw new ValidationError(`${key} zorunludur`, key);
        return undefined;
      }
      if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) {
        throw new ValidationError(`${key} ${min}-${max} karakter olmalıdır`, key);
      }
      return v.trim();
    };
    const typeRaw = o.subMerchantType ?? 'PRIVATE_COMPANY';
    if (typeof typeRaw !== 'string' || !(SUB_MERCHANT_TYPES as readonly string[]).includes(typeRaw)) {
      throw new ValidationError(`subMerchantType şu değerlerden biri olmalıdır: ${SUB_MERCHANT_TYPES.join(', ')}`, 'subMerchantType');
    }
    const type = typeRaw as SubMerchantType;
    const email = str('email', 5, 254, true) as string;
    if (!EMAIL.test(email)) throw new ValidationError('email geçerli bir e-posta adresi olmalıdır', 'email');
    const gsm = normalizeGsm(str('gsmNumber', 10, 20, true) as string);
    if (!gsm) throw new ValidationError('gsmNumber geçerli bir cep telefonu numarası olmalıdır', 'gsmNumber');
    const iban = (str('iban', 26, 40, true) as string).replace(/\s/g, '').toUpperCase();
    if (!isValidTrIban(iban)) throw new ValidationError('iban geçerli bir TR IBAN olmalıdır', 'iban');
    const company = type !== 'PERSONAL';
    const taxNumber = str('taxNumber', 10, 10, type === 'LIMITED_OR_JOINT_STOCK_COMPANY');
    if (taxNumber && !/^\d{10}$/.test(taxNumber)) throw new ValidationError('taxNumber 10 haneli olmalıdır', 'taxNumber');
    const identityNumber = str('identityNumber', 11, 11, type === 'PERSONAL');
    if (identityNumber && !TCKN.test(identityNumber)) {
      throw new ValidationError('identityNumber 11 haneli T.C. kimlik numarası olmalıdır', 'identityNumber');
    }
    const fee = o.platformFeeBasisPoints ?? 0;
    if (typeof fee !== 'number' || !Number.isInteger(fee) || fee < 0 || fee > MAX_PLATFORM_FEE_BASIS_POINTS) {
      throw new ValidationError(`platformFeeBasisPoints 0-${MAX_PLATFORM_FEE_BASIS_POINTS} tam sayı olmalıdır`, 'platformFeeBasisPoints');
    }
    return {
      feeBps: fee,
      request: {
        subMerchantType: type,
        externalId: apartmentId,
        name: str('name', 2, 200, false),
        email,
        gsmNumber: gsm,
        address: str('address', 5, 500, true) as string,
        iban,
        taxOffice: str('taxOffice', 2, 100, company),
        taxNumber,
        legalCompanyTitle: str('legalCompanyTitle', 2, 300, company),
        contactName: str('contactName', 2, 100, !company),
        contactSurname: str('contactSurname', 2, 100, !company),
        identityNumber,
      },
    };
  }

  /**
   * Apartmani saglayicida alt uye isyeri olarak kaydeder. KYC verisi (vergi no, IBAN, TCKN)
   * saglayicida kalir; bizde yalnizca `subMerchantKey`, tip, maskeli IBAN ve platform payi.
   */
  async function onboardSubMerchant(ctx: { userId: string }, apartmentId: string, body: unknown) {
    await requireSite(apartmentId);
    if (!provider) throw new PaymentsError('payments_disabled', 'Online ödeme yapılandırılmamış');
    const { request, feeBps } = parseSubMerchant(apartmentId, body);
    if (await repo.getAccount(apartmentId, provider.name)) {
      throw new PaymentsError('conflict', 'Bu apartman zaten kayıtlı; durum ve platform payı için PATCH kullanın');
    }
    let subMerchantKey: string;
    try {
      ({ subMerchantKey } = await provider.registerSubMerchant(request));
    } catch (err) {
      if (err instanceof PaymentProviderError && !err.retryable && err.code !== 'config') {
        throw new PaymentsError('provider_rejected', `Ödeme sağlayıcısı kaydı reddetti: ${err.message}`);
      }
      deps.log('error', 'alt uye isyeri kaydi basarisiz', { apartmentId, code: err instanceof PaymentProviderError ? err.code : 'unknown' });
      throw new PaymentsError('provider_unavailable', 'Ödeme sağlayıcısına şu an ulaşılamıyor');
    }
    const ts = stamp();
    const account: PaymentAccount = {
      ...paymentKeys.account(apartmentId, provider.name),
      entityType: 'PAYMENT_ACCOUNT',
      apartmentId,
      provider: provider.name,
      subMerchantKey,
      subMerchantType: request.subMerchantType,
      ibanMasked: maskIban(request.iban),
      status: 'active',
      platformFeeBasisPoints: feeBps,
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    try {
      await repo.putAccount(account);
    } catch (err) {
      if (err instanceof PaymentsConflictError) throw new PaymentsError('conflict', 'Bu apartman eş zamanlı olarak kaydedildi');
      throw err;
    }
    deps.log('info', 'AUDIT alt uye isyeri kaydedildi', {
      audit: 'PAYMENT_ACCOUNT_ONBOARDED',
      apartmentId,
      by: ctx.userId,
      subMerchantType: account.subMerchantType,
      ibanMasked: account.ibanMasked,
    });
    return accountView(account);
  }

  /** Durum (aktif/pasif) ve platform payi; surum kosullu. */
  async function updateAccount(ctx: { userId: string }, apartmentId: string, body: unknown) {
    await requireSite(apartmentId);
    if (!provider) throw new PaymentsError('payments_disabled', 'Online ödeme yapılandırılmamış');
    const current = await repo.getAccount(apartmentId, provider.name);
    if (!current) throw new PaymentsError('not_found', 'Bu apartman için alt üye işyeri kaydı yok');
    const o = asObject(body);
    let status = current.status;
    if (o.status !== undefined) {
      if (o.status !== 'active' && o.status !== 'disabled') throw new ValidationError('status active veya disabled olmalıdır', 'status');
      status = o.status;
    }
    let fee = current.platformFeeBasisPoints;
    if (o.platformFeeBasisPoints !== undefined) {
      const v = o.platformFeeBasisPoints;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_PLATFORM_FEE_BASIS_POINTS) {
        throw new ValidationError(`platformFeeBasisPoints 0-${MAX_PLATFORM_FEE_BASIS_POINTS} tam sayı olmalıdır`, 'platformFeeBasisPoints');
      }
      fee = v;
    }
    const next: PaymentAccount = {
      ...current,
      status,
      platformFeeBasisPoints: fee,
      updatedAt: stamp(),
      updatedBy: ctx.userId,
      version: current.version + 1,
    };
    try {
      await repo.putAccount(next, current.version);
    } catch (err) {
      if (err instanceof PaymentsConflictError) throw new PaymentsError('conflict', 'Kayıt başka biri tarafından değiştirildi');
      throw err;
    }
    deps.log('info', 'AUDIT alt uye isyeri guncellendi', {
      audit: 'PAYMENT_ACCOUNT_UPDATED',
      apartmentId,
      by: ctx.userId,
      status,
      platformFeeBasisPoints: fee,
    });
    return accountView(next);
  }

  // ----- Yonetici: apartmanin online odemeleri (salt okunur) -----

  /** Yonetici gorunumu: sakin goruntusundan farkli olarak niyet sahibi, platform payi ve inceleme nedeni de doner. */
  function managerView(i: PaymentIntent) {
    return {
      intentId: i.intentId,
      status: i.status,
      mode: i.mode,
      unitId: i.unitId,
      userId: i.userId,
      currency: 'TRY' as const,
      amount: i.amount,
      platformFee: i.platformFee,
      allocations: i.allocations.map((a) => ({
        liableParty: a.liableParty,
        principal: a.principal,
        lateFee: a.lateFee,
        amount: a.amount,
      })),
      provider: i.provider,
      providerPaymentId: i.providerPaymentId,
      paidAt: i.paidAt,
      paymentIds: i.paymentIds,
      receiptNumbers: i.receiptNumbers,
      failure: i.failure ? { code: i.failure.code, message: i.failure.message, at: i.failure.at } : undefined,
      review: i.review ? { reason: i.review.reason, at: i.review.at } : undefined,
      // Yonetici karari ve gerekcesini gorur (salt okunur); saglayici yanit ayrintisi platformda kalir.
      resolution: i.resolution ? { action: i.resolution.action, note: i.resolution.note, at: i.resolution.at } : undefined,
      refundedAmount: i.refund ? i.refund.items.filter((r) => r.status === 'succeeded').reduce((sum, r) => sum + r.amount, 0) : undefined,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    };
  }

  async function listIntentsForManager(
    apartmentId: string,
    query: { status?: string; limit?: string; cursor?: string } = {},
  ) {
    let status: IntentStatus | undefined;
    if (query.status !== undefined && query.status !== '') {
      if (!(INTENT_STATUSES as readonly string[]).includes(query.status)) {
        throw new ValidationError(`status şu değerlerden biri olmalıdır: ${INTENT_STATUSES.join(', ')}`, 'status');
      }
      status = query.status as IntentStatus;
    }
    const limit = query.limit === undefined || query.limit === '' ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INTENT_PAGE) {
      throw new ValidationError(`limit 1-${MAX_INTENT_PAGE} arasında olmalıdır`, 'limit');
    }
    try {
      const page = await repo.listIntents(apartmentId, { status, limit, cursor: query.cursor || undefined });
      return { items: page.items.map(managerView), nextCursor: page.cursor };
    } catch (err) {
      if (err instanceof InvalidIntentCursorError) throw new ValidationError('Geçersiz sayfa imleci', 'cursor');
      throw err;
    }
  }

  /** Yonetici icin online odeme durumu: anahtar (subMerchantKey) gosterilmez. */
  async function accountSummary(apartmentId: string) {
    if (!provider) return { configured: false as const, status: 'not_registered' as const };
    const account = await repo.getAccount(apartmentId, provider.name);
    if (!account) return { configured: true as const, provider: provider.name, sandbox: provider.sandbox, status: 'not_registered' as const };
    return {
      configured: true as const,
      provider: provider.name,
      sandbox: provider.sandbox,
      status: account.status,
      subMerchantType: account.subMerchantType,
      ibanMasked: account.ibanMasked,
      platformFeeBasisPoints: account.platformFeeBasisPoints,
      updatedAt: account.updatedAt,
    };
  }

  // ----- Platform: apartman listesi + alt uye isyeri durumu -----

  async function listApartmentAccounts() {
    const ids = await deps.core.listSiteIds();
    const rows = await Promise.all(
      ids.map(async (apartmentId) => {
        const [site, account] = await Promise.all([
          deps.core.getSite(apartmentId),
          provider ? repo.getAccount(apartmentId, provider.name) : Promise.resolve(undefined),
        ]);
        if (!site) return undefined;
        return {
          apartmentId,
          name: site.name,
          city: site.address.city,
          district: site.address.district,
          siteStatus: site.status,
          account: account ? accountView(account) : null,
        };
      }),
    );
    const items = rows
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    return { provider: provider?.name ?? null, sandbox: provider?.sandbox ?? null, items };
  }

  return {
    provider,
    quote,
    listIntentsForManager,
    accountSummary,
    listApartmentAccounts,
    createIntent,
    getIntent,
    handleCallback,
    handleWebhook,
    reconcile,
    getAccount,
    onboardSubMerchant,
    updateAccount,
    listReviewQueue,
    checkReview,
    resolveReview,
    reconcileRefunds,
  };
}

export type PaymentsService = ReturnType<typeof createPaymentsService>;
