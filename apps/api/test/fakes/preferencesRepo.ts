import type { NotificationPreferences, PreferencesRepository } from '../../src/modules/notifications/preferences.js';

/**
 * Bellek ici tercih deposu; `patch` DynamoDB `UpdateExpression SET` gibi yalnizca verilen alanlari
 * yazar (okuma-birlestirme-yazma yok). Her cagri bir mikro gorev bekler: es zamanli istekler araya girer.
 */
export function createFakePreferencesRepo() {
  const store = new Map<string, NotificationPreferences>();
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  const calls: string[] = [];
  const repository: PreferencesRepository = {
    async get(userId) {
      calls.push(`get:${userId}`);
      await tick();
      return structuredClone(store.get(userId) ?? { email: { enabled: true } });
    },
    async patch(userId, p) {
      calls.push(`patch:${userId}`);
      await tick();
      const cur = store.get(userId);
      store.set(userId, {
        email: { ...(cur?.email ?? { enabled: true }), ...(p.enabled === undefined ? {} : { enabled: p.enabled }), ...p.categories },
        updatedAt: p.updatedAt,
      });
    },
  };
  return { repository, store, calls };
}
