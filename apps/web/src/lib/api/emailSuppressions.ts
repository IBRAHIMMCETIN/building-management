import { z } from 'zod';
import { apiClient } from './client';

/*
 * Platform: SES geri donus / sikayet e-posta engelleri (apps/api/src/modules/notifications/suppressions.ts).
 *   GET  /api/admin/email-suppressions?status=active|all&cursor=
 *   POST /api/admin/email-suppressions/lookup         { email }  (adres URL'de tasinmaz)
 *   POST /api/admin/email-suppressions/:hash/clear    { reason } (platform denetim zinciri)
 * Adresin kendisi saklanmaz: ekranda maskeli bicim (a***@ornek.com).
 */

export const suppressionSchema = z.object({
  emailHash: z.string(),
  emailMasked: z.string(),
  reason: z.enum(['bounce', 'complaint']),
  bounceType: z.string().optional(),
  bounceSubType: z.string().optional(),
  feedbackType: z.string().optional(),
  at: z.string(),
  recordedAt: z.string(),
  status: z.enum(['active', 'cleared']),
  clearedAt: z.string().optional(),
  clearedBy: z.string().optional(),
  clearReason: z.string().optional(),
  expiresAt: z.string().optional(),
  active: z.boolean(),
});
export type EmailSuppression = z.infer<typeof suppressionSchema>;

const listSchema = z.object({ items: z.array(suppressionSchema), cursor: z.string().optional() });
const lookupSchema = z.object({ emailHash: z.string(), suppression: suppressionSchema.nullable() });

const BASE = '/api/admin/email-suppressions';

export const emailSuppressionsApi = {
  list: (status: 'active' | 'all', cursor?: string, signal?: AbortSignal) =>
    apiClient.get(BASE, { signal, query: { status, ...(cursor ? { cursor } : {}) }, schema: listSchema }),
  lookup: (email: string) => apiClient.post(`${BASE}/lookup`, { email }, { schema: lookupSchema }),
  clear: (emailHash: string, reason: string) => apiClient.post(`${BASE}/${encodeURIComponent(emailHash)}/clear`, { reason }, { schema: suppressionSchema }),
};

/** Neden + tur: "Kalıcı geri dönüş", "Geçici geri dönüş (7 gün)", "Şikâyet (spam)". */
export function suppressionReasonText(s: Pick<EmailSuppression, 'reason' | 'bounceType' | 'feedbackType'>): string {
  if (s.reason === 'complaint') return s.feedbackType ? `Şikâyet (${s.feedbackType})` : 'Şikâyet';
  return s.bounceType === 'Permanent' ? 'Kalıcı geri dönüş' : 'Geçici geri dönüş';
}

export function suppressionTone(s: Pick<EmailSuppression, 'reason' | 'bounceType' | 'active'>): 'danger' | 'warning' | 'neutral' {
  if (!s.active) return 'neutral';
  return s.reason === 'bounce' && s.bounceType !== 'Permanent' ? 'warning' : 'danger';
}

/** Kaldirma gerekcesi (API ile ayni sinir). */
export function clearReasonError(reason: string): string | undefined {
  const n = reason.trim().length;
  return n < 5 || n > 300 ? 'Gerekçe 5-300 karakter olmalı.' : undefined;
}
