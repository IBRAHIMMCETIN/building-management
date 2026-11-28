import { errorMessage } from '@bm/shared/api/errors';
import { useQueryClient } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@/context/AuthProvider';
import { useOnForeground } from '@/hooks/useAppForeground';
import { contextsQueryKey, useContexts } from '@/hooks/useContexts';
import { notificationUrl, resolveNotificationTarget } from '@/lib/push/notificationTarget';
import type { NotificationTap } from '@/lib/push/types';
import { useServices } from '@/services';

/**
 * Bildirim olaylari (kok yigin icinde, oturumun altinda):
 *  - Dokunma (uygulama acikken veya soguk acilista): karar `resolveNotificationTarget`'ta; baska
 *    apartmana ait bildirimde once baglam degisir, sonra `data.url` (role gore DeepLinkRedirect).
 *    Oturum / rol yoksa yol bekletilir, giris (ve baglam secimi) sonrasi acilir. Islenen dokunma
 *    saklanan "son yanit"tan silinir: kok yeniden kurulunca eski hedef tekrar acilmaz.
 *  - On planda gelen bildirim: aktif apartmanin onbellegi tazelenir; gosterim kurali PushService.shouldShow.
 *  - Uygulama one gelince izin durumu tazelenir (ayarlardan acilmis olabilir).
 */
export function NotificationObserver(): null {
  const { notifications, notices, push, fetchContexts } = useServices();
  const { session, setActiveContext } = useAuth();
  const queryClient = useQueryClient();
  const router = useRouter();
  const contexts = useContexts();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const handled = useRef(new Set<string>());
  /** Oturum yokken dokunulan bildirim (giristen sonra acilir). */
  const pending = useRef<NotificationTap | null>(null);

  // On plan gosterimi icin kullanicinin apartmanlari.
  useEffect(() => {
    push.setKnownApartments((contexts.data?.contexts ?? []).map((c) => c.apartmentId));
  }, [contexts.data, push]);

  const open = useCallback(
    async (tap: NotificationTap) => {
      if (handled.current.has(tap.id)) return;
      handled.current.add(tap.id);
      notifications.clearLastTap();
      const url = notificationUrl(tap.data);
      if (!url) return;
      const current = sessionRef.current;
      if (!current?.claims.role) {
        // Giris / baglam secimi bitince acilir; o zamana kadar acilis kurali (giris ekrani) gecerli.
        pending.current = tap;
        router.navigate('/');
        return;
      }
      const claims = current.claims;
      const needsContexts = typeof tap.data.apartmentId === 'string' && tap.data.apartmentId !== claims.apartmentId;
      try {
        const list = needsContexts
          ? (await queryClient.fetchQuery({ queryKey: contextsQueryKey(claims), queryFn: ({ signal }) => fetchContexts(current, signal), staleTime: 60_000 })).contexts
          : [];
        const decision = resolveNotificationTarget(tap.data, { active: claims, contexts: list });
        if (decision.kind === 'ignore') return;
        if (decision.kind === 'unavailable') {
          notices.show(decision.message, 'warning');
          router.navigate('/');
          return;
        }
        if (decision.kind === 'switch') await setActiveContext(decision.context);
        // Baglam degisince korumali yigin yeniden kurulur; yonlendirme bir sonraki turda.
        setTimeout(() => router.navigate(decision.url as Href, { withAnchor: true }), 0);
      } catch (err) {
        notices.show(`Bildirim açılamadı: ${errorMessage(err)}`, 'warning');
        router.navigate('/');
      }
    },
    [fetchContexts, notices, notifications, queryClient, router, setActiveContext],
  );

  useEffect(() => notifications.onTap((tap) => void open(tap)), [notifications, open]);

  // Soguk acilis: uygulamayi acan bildirim bir kez.
  const coldStart = useRef(false);
  useEffect(() => {
    if (coldStart.current) return;
    coldStart.current = true;
    void notifications
      .lastTap()
      .then((tap) => tap && open(tap))
      .catch(() => undefined);
  }, [notifications, open]);

  // Giristen (ve baglam seciminden) sonra bekleyen bildirim.
  const role = session?.claims.role;
  useEffect(() => {
    const tap = pending.current;
    if (!role || !tap) return;
    pending.current = null;
    handled.current.delete(tap.id);
    setTimeout(() => void open(tap), 0);
  }, [role, open]);

  useEffect(
    () =>
      notifications.onReceived((data) => {
        const apt = sessionRef.current?.claims.apartmentId;
        if (apt && (data.apartmentId === undefined || data.apartmentId === apt)) void queryClient.invalidateQueries({ queryKey: ['apartment', apt] });
      }),
    [notifications, queryClient],
  );

  useOnForeground(() => {
    if (sessionRef.current) void push.sync();
  });

  return null;
}
