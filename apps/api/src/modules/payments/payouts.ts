/**
 * Online Odeme v2 · P4: platform transferlerinin (PayTR) izlenmesi.
 *
 *  - Transfer sonuc bildirimi (`POST /api/payments/:provider/transfer-webhook`): imzali; listelenen
 *    transferler SETTLED olur. Geri donen odemenin yeniden gonderim sonucu (`mode=cashout`) ayni
 *    adrese gelir: RESENT veya RESEND_FAILED (+ alarm).
 *  - Geri donen aktarimlar: saglayici bildirim gondermez; gunluk `payout_returns` isi listeyi
 *    ceker ve (son 4 hane + tutar + talimat gunu) ile aktarim kaydina esler -> RETURNED + KRITIK
 *    alarm (`PAYOUT_RETURNED`). Eslesmeyen kayit `PAYOUT_RETURN_UNMATCHED` alarmi uretir.
 *  - Yeniden gonderim: platform ekibi (opsiyonel duzeltilmis IBAN/ad ile; IBAN KMS ile sifrelenir ve
 *    apartman hesabi da guncellenir) RESEND_PENDING yapar; zamanlanmis worker cozer ve gonderir.
 *
 * Tum gorunumlerde IBAN maskeli; sifreli alici hicbir yanita/loga girmez.
 */
import { toKurus } from '../core/types.js';
import { ValidationError, asObject, assertId } from '../core/validation.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import { type Payee, type PayeeVault, ibanLast4, isValidTrIban, maskIban, normalizeIban, normalizePayeeName } from './payee.js';
import { type PaymentProvider, PaymentProviderError, type TransferEvent, type WebhookInput, type WebhookReply } from './provider.js';
import type { ProviderRegistry } from './registry.js';
import { PaymentsConflictError, type PaymentsRepository, paymentKeys, paymentsRepository } from './repository.js';
import { PaymentsError, type PaymentsLog, defaultLog } from './service.js';
import { PAYMENT_PROVIDERS, PAYOUT_ATTENTION_STATUSES, PAYOUT_STATUSES, type PaymentAccount, type PayoutStatus, type PayoutTransfer } from './types.js';

/** Geri donen aktarim taramasinin penceresi (gun). */
export const RETURN_LOOKBACK_DAYS = 35;
/** Platform listesinin varsayilan penceresi (gun). */
export const PAYOUT_LIST_DAYS = 90;
/** Yeniden gonderim en fazla bu kadar denenir (worker 15 dakikada bir). */
export const MAX_RESEND_ATTEMPTS = 5;
const NOTE_MIN = 5;
const NOTE_MAX = 500;

export type PayoutServiceDeps = {
  repository?: PaymentsRepository;
  providers: ProviderRegistry;
  vault?: PayeeVault;
  core?: Pick<CoreRepository, 'getSite'>;
  now?: () => Date;
  log?: PaymentsLog;
};

/** Gorunum: sifreli alici cikarilir (yalnizca maskeli IBAN). */
export function payoutView(p: PayoutTransfer) {
  const { PK: _pk, SK: _sk, resend, ...rest } = p as PayoutTransfer & { GSI1PK?: string; GSI1SK?: string };
  const { GSI1PK: _a, GSI1SK: _b, ...clean } = rest as typeof rest & { GSI1PK?: string; GSI1SK?: string };
  if (!resend) return clean;
  const { payeeCiphertext: _c, ...resendView } = resend;
  return { ...clean, resend: resendView };
}

export function createPayoutService(overrides: PayoutServiceDeps) {
  const deps = { repository: paymentsRepository, core: coreRepository, now: () => new Date(), log: defaultLog, ...overrides };
  const repo = deps.repository;
  const stamp = () => deps.now().toISOString();

  async function save(current: PayoutTransfer, patch: Partial<PayoutTransfer>, ref?: Parameters<PaymentsRepository['updatePayout']>[2]): Promise<PayoutTransfer> {
    const next: PayoutTransfer = { ...current, ...patch, updatedAt: stamp(), version: current.version + 1 };
    await repo.updatePayout(next, current.version, ref);
    return next;
  }

  /** Transfer veya yeniden gonderim kimligi -> aktarim kaydi. */
  async function payoutOf(provider: PaymentProvider, reference: string): Promise<PayoutTransfer | undefined> {
    const ref = await repo.getPayoutRef(provider.name, reference);
    if (!ref) return undefined;
    return repo.getPayout(ref.apartmentId, ref.transferId);
  }

  // ----- Transfer sonuc bildirimi -----

  async function handleTransferWebhook(providerName: string, input: WebhookInput): Promise<{ status: 200 | 401 | 404 | 503; reply?: WebhookReply }> {
    const provider = deps.providers.get(providerName);
    if (!provider?.verifyTransferWebhook) return { status: 404 };
    let event: TransferEvent | null;
    try {
      event = await provider.verifyTransferWebhook(input);
    } catch (err) {
      deps.log('error', 'transfer bildirimi dogrulanamadi (anahtar okunamadi)', { code: err instanceof PaymentProviderError ? err.code : 'unknown' });
      return { status: 503 };
    }
    if (!event) {
      deps.log('warn', 'transfer bildirimi imzasi gecersiz', { providerName });
      return { status: 401 };
    }
    const ok = { status: 200 as const, reply: provider.webhookReply?.() };
    if (event.kind === 'settled') {
      for (const id of event.transferIds) {
        const p = await payoutOf(provider, id);
        if (!p) {
          deps.log('warn', 'transfer bildirimi bilinmeyen kimlik', { providerName, transferId: id });
          continue;
        }
        // Yalnizca ilk gonderim SETTLED olur; geri donen / yeniden gonderilen kayit bozulmaz.
        if (p.status === 'SENT') await retrying(() => save(p, { status: 'SETTLED', settledAt: stamp() }), p, 'SETTLED');
      }
      return ok;
    }
    const p = await payoutOf(provider, event.resendId);
    if (!p || p.resend?.resendId !== event.resendId) {
      deps.log('warn', 'yeniden gonderim bildirimi bilinmeyen kimlik', { providerName, resendId: event.resendId });
      return ok;
    }
    if (p.status !== 'RESEND_SENT' && p.status !== 'RESEND_PENDING') return ok; // tekrar gelen bildirim
    const success = event.results.length > 0 && event.results.every((r) => r.result === 'success');
    const at = stamp();
    await retrying(
      () =>
        save(p, {
          status: success ? 'RESENT' : 'RESEND_FAILED',
          resend: {
            ...(p.resend as NonNullable<PayoutTransfer['resend']>),
            completedAt: at,
            ...(success ? {} : { error: { code: 'resend_failed', message: 'Saglayici yeniden gonderimi basarisiz bildirdi', at } }),
          },
        }),
      p,
      success ? 'RESENT' : 'RESEND_FAILED',
    );
    if (!success) {
      deps.log('error', 'ALARM geri donen aktarimin yeniden gonderimi basarisiz', {
        alert: 'PAYOUT_FAILED',
        apartmentId: p.apartmentId,
        transferId: p.transferId,
        resendId: event.resendId,
        ibanMasked: p.resend?.ibanMasked,
      });
    }
    return ok;
  }

  /** Surum cakismasinda guncel kaydi okuyup bir kez daha dener (bildirimler es zamanli gelebilir). */
  async function retrying(op: () => Promise<PayoutTransfer>, p: PayoutTransfer, target: PayoutStatus): Promise<void> {
    try {
      await op();
    } catch (err) {
      if (!(err instanceof PaymentsConflictError)) throw err;
      const fresh = await repo.getPayout(p.apartmentId, p.transferId);
      if (fresh && fresh.status !== target) {
        deps.log('warn', 'aktarim kaydi es zamanli degisti', { transferId: p.transferId, status: fresh.status, target });
      }
    }
  }

  // ----- Geri donen aktarimlar (gunluk) -----

  /**
   * Saglayicinin geri donen aktarim listesini aktarim kayitlariyla esler. Idempotent: ayni
   * `refNo` ikinci kez islenmez. Esleme: maskeli IBAN'in son 4 hanesi + tutar + talimat gunu
   * (saglayici transfer kimligi vermez). Birden fazla aday varsa otomatik esleme yapilmaz.
   */
  async function detectReturned() {
    const now = deps.now();
    const result = { checked: 0, returned: 0, alreadyKnown: 0, unmatched: 0 };
    const transfers = await repo.listPayoutsSince(new Date(now.getTime() - (RETURN_LOOKBACK_DAYS + 30) * 86_400_000).toISOString());
    for (const provider of deps.providers.list()) {
      if (!provider.listReturnedTransfers) continue;
      const returned = await provider.listReturnedTransfers({ from: new Date(now.getTime() - RETURN_LOOKBACK_DAYS * 86_400_000), to: now });
      const mine = transfers.filter((t) => t.provider === provider.name);
      for (const r of returned) {
        result.checked++;
        if (mine.some((t) => t.returned?.refNo === r.refNo)) {
          result.alreadyKnown++;
          continue;
        }
        const candidates = mine.filter(
          (t) =>
            (t.status === 'SENT' || t.status === 'SETTLED') &&
            t.ibanLast4 === r.ibanLast4 &&
            t.amount === r.amount &&
            (!r.transferDate || istanbulDay(t.sentAt) <= r.transferDate),
        );
        // Ayni gun/IBAN/tutar birden fazla aktarim: en yakin talimat gunu tercih edilir; yine
        // de birden fazla kalirsa elle incelenir.
        const exact = r.transferDate ? candidates.filter((t) => istanbulDay(t.sentAt) === r.transferDate) : candidates;
        const pick = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
        if (!pick) {
          result.unmatched++;
          deps.log('error', 'ALARM geri donen aktarim eslestirilemedi', {
            alert: 'PAYOUT_RETURN_UNMATCHED',
            provider: provider.name,
            refNo: r.refNo,
            ibanLast4: r.ibanLast4,
            amount: r.amount,
            transferDate: r.transferDate,
            candidates: candidates.length,
          });
          continue;
        }
        await save(pick, {
          status: 'RETURNED',
          returned: { refNo: r.refNo, detectedAt: stamp(), ...(r.returnedOn ? { returnedOn: r.returnedOn } : {}), amount: r.amount },
        });
        pick.status = 'RETURNED';
        pick.returned = { refNo: r.refNo, detectedAt: stamp(), amount: r.amount };
        result.returned++;
        deps.log('error', 'ALARM aktarim geri dondu (hatali IBAN / hesap adi)', {
          alert: 'PAYOUT_RETURNED',
          severity: 'critical',
          apartmentId: pick.apartmentId,
          transferId: pick.transferId,
          intentId: pick.intentId,
          amount: pick.amount,
          ibanMasked: pick.ibanMasked,
          refNo: r.refNo,
        });
      }
    }
    return result;
  }

  // ----- Yeniden gonderim -----

  /**
   * Platform: geri donen (veya yeniden gonderimi basarisiz) aktarimi yeniden gonderime alir.
   * Govde: `{ note, expectedVersion, iban?, accountHolderName? }`. IBAN verilirse KMS ile
   * sifrelenir ve apartmanin odeme hesabi da guncellenir (sonraki transferler icin).
   */
  async function requestResend(ctx: { userId: string }, apartmentId: string, transferId: string, body: unknown) {
    assertId(apartmentId, 'apartmentId');
    assertId(transferId, 'transferId');
    const o = asObject(body);
    const note = typeof o.note === 'string' ? o.note.trim() : '';
    if (note.length < NOTE_MIN || note.length > NOTE_MAX) throw new ValidationError(`note ${NOTE_MIN}-${NOTE_MAX} karakter olmalıdır`, 'note');
    const p = await repo.getPayout(apartmentId, transferId);
    if (!p) throw new PaymentsError('not_found', 'Aktarım bulunamadı');
    if (o.expectedVersion !== p.version) throw new PaymentsError('conflict', 'Aktarım başka bir işlemle değişti; güncel hali alıp tekrar deneyin');
    if (p.status !== 'RETURNED' && p.status !== 'RESEND_FAILED') {
      throw new PaymentsError('action_not_allowed', 'Yalnızca geri dönen veya yeniden gönderimi başarısız aktarım yeniden gönderilebilir');
    }
    const provider = deps.providers.get(p.provider);
    if (!provider?.resendReturned) throw new PaymentsError('payments_disabled', 'Bu aktarımın sağlayıcısı yeniden gönderimi desteklemiyor veya kapalı');

    const account = await repo.getAccount(apartmentId, p.provider);
    if (!account) throw new PaymentsError('not_found', 'Apartmanın ödeme hesabı bulunamadı');
    let ciphertext = account.payeeCiphertext;
    let ibanMasked = account.ibanMasked ?? p.ibanMasked;
    if (o.iban !== undefined || o.accountHolderName !== undefined) {
      if (typeof o.iban !== 'string' || !isValidTrIban(o.iban)) throw new ValidationError('iban geçerli bir TR IBAN olmalıdır', 'iban');
      const name = typeof o.accountHolderName === 'string' ? normalizePayeeName(o.accountHolderName) : undefined;
      if (!name) throw new ValidationError('accountHolderName 2-140 karakter olmalıdır (banka hesabındaki ad/unvan)', 'accountHolderName');
      const payee: Payee = { iban: normalizeIban(o.iban), name };
      ciphertext = await seal(apartmentId, provider, payee);
      ibanMasked = maskIban(payee.iban);
      // Duzeltilmis alici hesaba da yazilir: sonraki transferler yeni IBAN'a gider.
      const next: PaymentAccount = { ...account, payeeCiphertext: ciphertext, payeeUpdatedAt: stamp(), ibanMasked, updatedAt: stamp(), updatedBy: ctx.userId, version: account.version + 1 };
      try {
        await repo.putAccount(next, account.version);
      } catch (err) {
        if (err instanceof PaymentsConflictError) throw new PaymentsError('conflict', 'Ödeme hesabı başka biri tarafından değiştirildi');
        throw err;
      }
    }
    if (!ciphertext) throw new PaymentsError('action_not_allowed', 'Apartmanın kayıtlı aktarım alıcısı yok; IBAN ve hesap sahibi adını girin');

    const count = (p.resendCount ?? 0) + 1;
    const resendId = `${p.transferId}R${count}`;
    let next: PayoutTransfer;
    try {
      next = await save(p, {
        status: 'RESEND_PENDING',
        resendCount: count,
        resend: { resendId, requestedAt: stamp(), requestedBy: ctx.userId, note, payeeCiphertext: ciphertext, ibanMasked, attempts: 0 },
      });
    } catch (err) {
      if (err instanceof PaymentsConflictError) throw new PaymentsError('conflict', 'Aktarım başka bir işlemle değişti');
      throw err;
    }
    deps.log('info', 'AUDIT geri donen aktarim yeniden gonderime alindi', {
      audit: 'PAYOUT_RESEND_REQUESTED',
      apartmentId,
      transferId,
      resendId,
      by: ctx.userId,
      ibanMasked,
      payeeChanged: o.iban !== undefined,
    });
    return payoutView(next);
  }

  async function seal(apartmentId: string, provider: PaymentProvider, payee: Payee): Promise<string> {
    if (!deps.vault) throw new PaymentsError('payee_vault_unavailable', 'IBAN güvenli olarak saklanamıyor (şifreleme anahtarı yapılandırılmamış)');
    try {
      return await deps.vault.seal({ apartmentId, provider: provider.name }, payee);
    } catch (err) {
      deps.log('error', 'alici sifrelenemedi', { apartmentId, code: err instanceof PaymentProviderError ? err.code : 'unknown' });
      throw new PaymentsError('payee_vault_unavailable', 'IBAN şu an güvenli olarak saklanamıyor, lütfen tekrar deneyin');
    }
  }

  /** Worker: RESEND_PENDING kayitlari gonderir (IBAN yalnizca burada, bellekte cozulur). */
  async function processResends() {
    const result = { checked: 0, sent: 0, failed: 0, pending: 0 };
    const now = deps.now();
    const all = await repo.listPayoutsSince(new Date(now.getTime() - 400 * 86_400_000).toISOString());
    for (const p of all.filter((x) => x.status === 'RESEND_PENDING' && x.resend)) {
      result.checked++;
      const provider = deps.providers.get(p.provider);
      const r = p.resend as NonNullable<PayoutTransfer['resend']>;
      const at = stamp();
      try {
        if (!provider?.resendReturned) throw new PaymentProviderError('provider_disabled', 'Saglayici kapali', true);
        if (!deps.vault) throw new PaymentProviderError('payee_vault_unavailable', 'Alici kasasi yapilandirilmamis', true);
        const payee = await deps.vault.open({ apartmentId: p.apartmentId, provider: p.provider }, r.payeeCiphertext);
        await provider.resendReturned({ resendId: r.resendId, amount: p.returned?.amount ?? p.amount, payee });
        await save(
          p,
          { status: 'RESEND_SENT', resend: { ...r, attempts: r.attempts + 1, sentAt: at, error: undefined } },
          { ...paymentKeys.payoutRef(p.provider, r.resendId), entityType: 'PAYOUT_REF', provider: p.provider, reference: r.resendId, apartmentId: p.apartmentId, transferId: p.transferId, createdAt: at },
        );
        result.sent++;
      } catch (err) {
        if (err instanceof PaymentsConflictError) continue; // baska bir tur isledi
        const attempts = r.attempts + 1;
        const code = err instanceof PaymentProviderError ? err.code : 'unknown';
        const exhausted = attempts >= MAX_RESEND_ATTEMPTS || (err instanceof PaymentProviderError && !err.retryable);
        await save(p, {
          status: exhausted ? 'RESEND_FAILED' : 'RESEND_PENDING',
          resend: { ...r, attempts, error: { code, message: err instanceof Error ? err.message : 'bilinmeyen hata', at } },
        }).catch((e) => {
          if (!(e instanceof PaymentsConflictError)) throw e;
        });
        if (exhausted) {
          result.failed++;
          deps.log('error', 'ALARM geri donen aktarimin yeniden gonderimi basarisiz', {
            alert: 'PAYOUT_FAILED',
            apartmentId: p.apartmentId,
            transferId: p.transferId,
            resendId: r.resendId,
            code,
          });
        } else {
          result.pending++;
        }
      }
    }
    return result;
  }

  // ----- Platform listesi -----

  async function listPayouts(query: { status?: string; days?: string } = {}) {
    let statuses: readonly PayoutStatus[] = PAYOUT_ATTENTION_STATUSES;
    if (query.status) {
      if (query.status === 'all') statuses = PAYOUT_STATUSES;
      else if ((PAYOUT_STATUSES as readonly string[]).includes(query.status)) statuses = [query.status as PayoutStatus];
      else throw new ValidationError(`status şu değerlerden biri veya all olmalıdır: ${PAYOUT_STATUSES.join(', ')}`, 'status');
    }
    const days = query.days ? Number(query.days) : PAYOUT_LIST_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > 400) throw new ValidationError('days 1-400 arasında olmalıdır', 'days');
    const since = new Date(deps.now().getTime() - days * 86_400_000).toISOString();
    const items = (await repo.listPayoutsSince(since)).filter((p) => statuses.includes(p.status));
    const names = new Map<string, string>();
    for (const id of new Set(items.map((p) => p.apartmentId))) {
      const site = await deps.core.getSite(id);
      if (site) names.set(id, site.name);
    }
    return {
      items: items
        .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
        .map((p) => ({ ...payoutView(p), apartmentName: names.get(p.apartmentId) ?? null })),
    };
  }

  return { handleTransferWebhook, detectReturned, requestResend, processResends, listPayouts };
}

export type PayoutService = ReturnType<typeof createPayoutService>;

const istanbulDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date(iso));

/** Tum saglayici adlari (tip daraltma icin). */
export const PAYOUT_PROVIDERS = PAYMENT_PROVIDERS;
export { toKurus };
