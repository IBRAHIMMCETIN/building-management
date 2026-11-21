/**
 * Odeme sayfasinin acilis bicimi (saf yardimcilar). API niyet yanitinda `checkoutKind` dondurur:
 *  - `redirect` (iyzico): tam sayfa yonlendirme.
 *  - `iframe` (PayTR): odeme formu uygulama icinde gomulu acilir. Yalnizca izinli saglayici
 *    adreslerine iframe acilir; digerleri guvenli tarafta kalmak icin tam sayfa yonlendirilir.
 * Odeme sonrasi saglayici iframe icinde API callback'ine, oradan `/app/odeme/sonuc`'a doner;
 * sonuc sayfasi iframe icindeyse ust pencereye tasinir (`escapeFrame`).
 */
import type { PaymentIntent } from '@/lib/api/payments';

/** iFrame ile gomulmesine izin verilen odeme sayfalari (kaynak + yol oneki). */
export const EMBEDDABLE_CHECKOUTS: readonly { origin: string; pathPrefix: string }[] = [
  { origin: 'https://www.paytr.com', pathPrefix: '/odeme/guvenli/' },
];

export function isEmbeddableCheckout(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return EMBEDDABLE_CHECKOUTS.some((e) => u.origin === e.origin && u.pathname.startsWith(e.pathPrefix) && u.pathname.length > e.pathPrefix.length);
}

export type CheckoutAction = { kind: 'iframe'; url: string } | { kind: 'redirect'; url: string } | { kind: 'none' };

/** Olusturulan niyete gore sakinin odeme sayfasini nasil acacagi. */
export function checkoutAction(intent: Pick<PaymentIntent, 'status' | 'paymentPageUrl' | 'checkoutKind'>): CheckoutAction {
  if (intent.status !== 'PENDING' || !intent.paymentPageUrl) return { kind: 'none' };
  if (intent.checkoutKind === 'iframe' && isEmbeddableCheckout(intent.paymentPageUrl)) return { kind: 'iframe', url: intent.paymentPageUrl };
  return { kind: 'redirect', url: intent.paymentPageUrl };
}

type FrameWindow = Pick<Window, 'location'> & { self: unknown; top: (Pick<Window, 'location'> & { location: Pick<Location, 'replace'> }) | null };

/**
 * Sayfa bir iframe icinde aciksa (saglayici donusu) ayni adresi ust pencerede acar. Ust pencere
 * ayni kaynaktir (uygulamanin kendi odeme sayfasi). Tasindiysa true.
 */
export function escapeFrame(win: FrameWindow): boolean {
  if (!win.top || win.top === win.self) return false;
  try {
    win.top.location.replace(win.location.href);
    return true;
  } catch {
    // Ust pencere baska kaynaktaysa erisim engellenir: sayfa iframe icinde kalir.
    return false;
  }
}

/** Sonuc sayfasina saglayicidan donus: `?result=ok|fail` (yalnizca bilgi; durum API'den gelir). */
export function returnResult(value: string | null): 'ok' | 'fail' | undefined {
  return value === 'ok' || value === 'fail' ? value : undefined;
}
