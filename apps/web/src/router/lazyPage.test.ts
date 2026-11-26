// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isChunkLoadError, loadWithReload } from './lazyPage';

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('sayfa parcasi yukleme', () => {
  it('yeni surumden sonra kaybolan parca hatasini tanir', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/FinancePage-abc.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('boom'))).toBe(false);
  });

  it('parca hatasinda bir kez yeniler; ikinci hatada hata sayfasina birakir', async () => {
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
    const failing = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));

    const pending = loadWithReload(failing);
    await Promise.resolve();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
    void pending; // yenileme surerken cozulmez

    await expect(loadWithReload(failing)).rejects.toThrow('dynamically imported module');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('basarili yukleme yenileme isaretini temizler; baska hatalar aynen firlatilir', async () => {
    window.sessionStorage.setItem('bm:chunk-reload', '1');
    await expect(loadWithReload(async () => ({ Page: 'ok' }))).resolves.toEqual({ Page: 'ok' });
    expect(window.sessionStorage.getItem('bm:chunk-reload')).toBeNull();
    await expect(loadWithReload(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});
