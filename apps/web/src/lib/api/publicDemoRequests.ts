import { type DemoRequestPayload, demoRequestReceivedSchema } from '@bm/shared/api/demoRequests';
import { createApiClient } from './createApiClient';

/*
 * Tanitim sayfasinin tek API cagrisi: kimliksiz demo talebi.
 *   POST /api/public/demo-requests -> 201 { received: true } | 400 | 429 { retryAfterSeconds }
 *
 * Oturum yoneticisini (Amplify) ve `config/env` dogrulamasini import ETMEZ: tanitim sayfasi
 * uygulama kodunu indirmeden calisir ve derleme sonunda Node'da on-render edilir. Yalnizca API
 * adresi gerekir; `config/env.ts` ile ayni normallestirme (bos = goreli istek, sondaki / atilir).
 */
const baseUrl = String(import.meta.env.VITE_API_URL ?? '')
  .trim()
  .replace(/\/+$/, '');

const publicClient = createApiClient({ baseUrl, getToken: async () => null });

export function submitDemoRequest(payload: DemoRequestPayload, signal?: AbortSignal) {
  return publicClient.post('/api/public/demo-requests', payload, { auth: false, signal, schema: demoRequestReceivedSchema });
}
