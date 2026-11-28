import { errorMessage } from '@bm/shared/api/errors';
import { useQueryClient } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@/context/AuthProvider';
import { contextsQueryKey } from '@/hooks/useContexts';
import { useOnForeground } from '@/hooks/useAppForeground';
import { notificationUrl, resolveNotificationTarget } from '@/lib/push/notificationTarget';
import type { NotificationTap } from '@/lib/push/types';
import { useServices } from '@/services';

/**
 * Bildirim olaylari (kok yigin icinde, oturumun altinda):
 *  - Dokunma (uygulama acikken veya soguk acilista): karar `resolveNotificationTarget`'ta; baska
 *    apartmana ait bildirimde once baglam degisir, sonra `data.url` (role gore DeepLinkRedirect).
 *  - On planda gelen bildirim: aktif apartmanin onbellegi tazelenir (kapi / talep listeleri hemen guncellenir).
 *  - Uygulama one gelince izin durumu tazelenir (ayarlardan acilmis olabilir).
 */
export function NotificationObserver(): null {
  const { notifications, notices, push, fetchContexts } = useServices();
  const { session, setActiveContext } = useAuth();
  const queryClient = useQueryClient();
  const router = useRouter();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const handled = useRef(new Set<string>());

  const open = useCallback(
    async (tap: NotificationTap) => {
      if (handled.current.has(tap.id)) return;
      handled.current.add(tap.id);
      const url = notificationUrl(tap.data);
      if (!url) return;
      const current = sessionRef.current;
      // Oturum / rol yoksa yol acilis kuralina duser (giris, baglam secimi).
      if (!current?.claims.role) {
        router.navigate(url as Href);
        return;
      }
      const claims = current.claims;
      const needsContexts = typeof tap.data.apartmentId === 'string' && tap.data.apartmentId !== claims.apartmentId;
      try {
        const contexts = needsContexts
          ? (await queryClient.fetchQuery({ queryKey: contextsQueryKey(claims), queryFn: ({ signal }) => fetchContexts(current, signal), staleTime: 60_000 })).contexts
          : [];
        const decision = resolveNotificationTarget(tap.data, { active: claims, contexts });
        if (decision.kind === 'ignore') return;
        if (decision.kind === 'unavailable') {
          notices.show(decision.message, 'warning');
          router.navigate('/');
          return;
        }
        if (decision.kind === 'switch') await setActiveContext(decision.context);
        // Baglam degisince korumali yigin yeniden kurulur; yonlendirme bir sonraki turda.
        setTimeout(() => router.navigate(decision.url as Href), 0);
      } catch (err) {
        notices.show(`Bildirim açılamadı: ${errorMessage(err)}`, 'warning');
        router.navigate('/');
      }
    },
    [fetchContexts, notices, queryClient, router, setActiveContext],
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
