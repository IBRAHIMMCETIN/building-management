import { describe, expect, it } from 'vitest';
import { ApiError, errorMessage } from './errors';
import {
  MANAGEMENT_NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_META,
  categoryEnabled,
  notificationPreferencesSchema,
} from './notificationPreferences';

describe('abonelik: ortak hata ve tercih semasi', () => {
  it('salt okunur hata (423) taninir ve sunucunun Turkce mesaji gosterilir', () => {
    const err = new ApiError(423, { error: 'subscription_read_only', message: 'Aboneliğiniz askıya alındı; sistem salt okunur.' });
    expect(err.isReadOnly).toBe(true);
    expect(errorMessage(err)).toMatch(/salt okunur/);
    expect(new ApiError(423).message).toMatch(/salt okunur/);
    expect(new ApiError(403, { error: 'feature_not_in_plan' }).isReadOnly).toBe(false);
  });

  it('billing yalnizca yonetim kategorisi: sakin / mobil listesi degismez, sema alani tasir', () => {
    expect(NOTIFICATION_CATEGORIES).not.toContain('billing');
    expect(MANAGEMENT_NOTIFICATION_CATEGORIES).toEqual(['billing']);
    expect(NOTIFICATION_CATEGORY_META.billing.label).toBe('Abonelik ve faturalar');
    const prefs = notificationPreferencesSchema.parse({ email: { enabled: true, billing: false }, push: { enabled: true } });
    expect(categoryEnabled(prefs, 'billing')).toBe(false);
    expect(categoryEnabled(prefs, 'billing', 'push')).toBe(true);
  });
});
