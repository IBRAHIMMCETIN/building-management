import type { SessionClaims } from '@bm/shared/auth/session';

/*
 * Alan bazli demo verisi (EXPO_PUBLIC_API_MODE=demo): her alan kendi dosyasinda bir isleyici fabrikasi
 * verir; createDemoFetch (dev/demoApi.ts) sirayla sorar, ilk yanit veren kazanir. Durum isleyicinin
 * kapanisinda tutulur (onizleme oturumu boyunca; yenilemede sifirlanir). Gercek veri DEGILDIR.
 */
export type DemoRequest = {
  method: string;
  path: string;
  query: (key: string) => string | undefined;
  body: Record<string, unknown>;
  claims: SessionClaims;
  now: Date;
};

export type DemoResponse = { status: number; body?: unknown };

/** Bu alanin ucu degilse `undefined` (siradaki isleyiciye gecilir). */
export type DemoHandler = (req: DemoRequest) => DemoResponse | undefined;

export const ok = (body: unknown): DemoResponse => ({ status: 200, body });
export const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): DemoResponse => ({ status, body: { error, message, ...extra } });

/** Demo fotograf yukleme hedefi: imzali S3 linki yerine; PUT'u demo fetch yanitlar. */
export const DEMO_UPLOAD_PREFIX = '/demo-upload/';
export const demoUploadUrl = (id: string) => `https://demo.invalid${DEMO_UPLOAD_PREFIX}${id}`;
