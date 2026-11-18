// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoiceFileError, openSignedDocument } from './documentModel';

const file = (type: string, size: number) => new File([new Uint8Array(size)], 'f', { type });

describe('fatura dosyasi kontrolu (API ile ayni kurallar)', () => {
  it('tur ve boyut', () => {
    expect(invoiceFileError(file('application/pdf', 10))).toBeNull();
    expect(invoiceFileError(file('image/jpeg', 10))).toBeNull();
    expect(invoiceFileError(file('text/html', 10))).toMatch(/PDF/);
    expect(invoiceFileError(file('application/pdf', 0))).toMatch(/boş/);
    expect(invoiceFileError({ type: 'application/pdf', size: 10 * 1024 * 1024 + 1 } as File)).toMatch(/10 MB/);
  });
});

describe('openSignedDocument', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sekmeyi tiklama aninda acar, link gelince yonlendirir ve opener baglantisini keser', async () => {
    const win = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    await openSignedDocument(async () => ({ url: 'https://s3/x.pdf', fileName: 'x.pdf', contentType: 'application/pdf', expiresAt: '' }));
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    expect(win.location.href).toBe('https://s3/x.pdf');
    expect(win.opener).toBeNull();
  });

  it('hata olursa acilan bos sekme kapatilir ve hata yukari iletilir', async () => {
    const win = { opener: null, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    await expect(openSignedDocument(async () => Promise.reject(new Error('403')))).rejects.toThrow('403');
    expect(win.close).toHaveBeenCalled();
  });
});
