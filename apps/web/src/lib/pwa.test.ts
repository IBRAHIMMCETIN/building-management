// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from './pwa';

describe('registerServiceWorker', () => {
  it('gelistirmede ve desteklemeyen tarayicida kaydetmez', () => {
    expect(registerServiceWorker({ PROD: false }, { serviceWorker: {} } as Navigator)).toBe(false);
    expect(registerServiceWorker({ PROD: true }, {} as Navigator)).toBe(false);
  });

  it('production derlemesinde sayfa yuklenince /sw.js kaydedilir', () => {
    const register = vi.fn().mockResolvedValue({});
    expect(registerServiceWorker({ PROD: true }, { serviceWorker: { register } } as unknown as Navigator)).toBe(true);
    window.dispatchEvent(new Event('load'));
    expect(register).toHaveBeenCalledWith('/sw.js');
  });
});
