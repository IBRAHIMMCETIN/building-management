import type { DemoReply } from '../demoApi';

/*
 * Saha rolleri demo verisinin (gate.ts, work.ts) ortak yardimcilari. Isleyici sozlesmesi M2b ile
 * ortaktir (`DemoHandler`, dev/demoApi.ts); demo dosyalari yalnizca __DEV__ paketinde yuklenir
 * (services.tsx). Gercek veri DEGILDIR.
 */

export const ok = (body: unknown): DemoReply => ({ status: 200, body });
export const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): DemoReply => ({ status, body: { error, message, ...extra } });

/** Istek govdesi (JSON nesnesi; yoksa bos). */
export const bodyOf = (body: unknown): Record<string, unknown> => (body && typeof body === 'object' ? (body as Record<string, unknown>) : {});

/** Demo fotograf yukleme hedefi: imzali S3 linki yerine; PUT'u demo fetch yanitlar. */
export const DEMO_UPLOAD_PREFIX = '/demo-upload/';
export const demoUploadUrl = (id: string) => `https://demo.invalid${DEMO_UPLOAD_PREFIX}${id}`;
