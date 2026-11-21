import { describe, expect, it, vi } from 'vitest';
import { checkoutAction, escapeFrame, isEmbeddableCheckout, returnResult } from './checkout';

describe('odeme sayfasi acilis bicimi', () => {
  it('yalnizca izinli saglayici adresi iframe icinde acilir', () => {
    expect(isEmbeddableCheckout('https://www.paytr.com/odeme/guvenli/abc123')).toBe(true);
    expect(isEmbeddableCheckout('https://www.paytr.com/odeme/guvenli/')).toBe(false);
    expect(isEmbeddableCheckout('http://www.paytr.com/odeme/guvenli/abc')).toBe(false);
    expect(isEmbeddableCheckout('https://www.paytr.com.evil.test/odeme/guvenli/abc')).toBe(false);
    expect(isEmbeddableCheckout('https://evil.test/?u=https://www.paytr.com/odeme/guvenli/abc')).toBe(false);
    expect(isEmbeddableCheckout('javascript:alert(1)')).toBe(false);
    expect(isEmbeddableCheckout('bozuk')).toBe(false);
  });

  it('niyet: iframe (izinliyse), yonlendirme (iyzico veya izinsiz iframe), sonuclanmis niyette yok', () => {
    expect(checkoutAction({ status: 'PENDING', paymentPageUrl: 'https://www.paytr.com/odeme/guvenli/t1', checkoutKind: 'iframe' })).toEqual({
      kind: 'iframe',
      url: 'https://www.paytr.com/odeme/guvenli/t1',
    });
    expect(checkoutAction({ status: 'PENDING', paymentPageUrl: 'https://sandbox-cpp.iyzipay.com?token=t', checkoutKind: 'redirect' })).toEqual({
      kind: 'redirect',
      url: 'https://sandbox-cpp.iyzipay.com?token=t',
    });
    expect(checkoutAction({ status: 'PENDING', paymentPageUrl: 'https://baska.test/odeme', checkoutKind: 'iframe' })).toEqual({ kind: 'redirect', url: 'https://baska.test/odeme' });
    expect(checkoutAction({ status: 'PENDING', paymentPageUrl: 'https://x.test/p' })).toEqual({ kind: 'redirect', url: 'https://x.test/p' });
    expect(checkoutAction({ status: 'SUCCEEDED', paymentPageUrl: 'https://www.paytr.com/odeme/guvenli/t1', checkoutKind: 'iframe' })).toEqual({ kind: 'none' });
  });

  it('iframe icindeki sonuc sayfasi ust pencereye tasinir', () => {
    const replace = vi.fn();
    const top = { location: { replace } };
    const href = 'https://app.test/app/odeme/sonuc?intent=i1&result=ok';
    expect(escapeFrame({ self: {}, top, location: { href } as Location } as never)).toBe(true);
    expect(replace).toHaveBeenCalledWith(href);
    const self = {};
    expect(escapeFrame({ self, top: self, location: { href } as Location } as never)).toBe(false);
    const blocked = {
      location: {
        replace: () => {
          throw new DOMException('cross-origin', 'SecurityError');
        },
      },
    };
    expect(escapeFrame({ self: {}, top: blocked, location: { href } as Location } as never)).toBe(false);
  });

  it('donus sonucu yalnizca ok/fail', () => {
    expect([returnResult('ok'), returnResult('fail'), returnResult('x'), returnResult(null)]).toEqual(['ok', 'fail', undefined, undefined]);
  });
});
