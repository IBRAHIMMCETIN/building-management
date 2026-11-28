import { type ReactNode, createContext, use, useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthProvider';
import { preferences } from '@/lib/storage/preferences';

type PortalUnitValue = {
  unitId: string | undefined;
  selectUnit: (unitId: string | undefined) => void;
  /** Kayitli secim okundu (okunmadan portal sorgulari baslamaz; gereksiz "otomatik" istek olmaz). */
  ready: boolean;
};

const PortalUnitContext = createContext<PortalUnitValue | null>(null);

const storageKey = (userId: string, apartmentId: string) => `bm.portal-unit.${userId}.${apartmentId}`;

/**
 * Birden fazla dairesi olan sakinin secili dairesi (web: context/PortalUnitContext.tsx). Kullanici +
 * apartman bazinda saklanir; API her istekte daireyi uyeliklere karsi yeniden dogrular.
 */
export function PortalUnitProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const key = user?.apartmentId ? storageKey(user.sub, user.apartmentId) : null;
  const [state, setState] = useState<{ key: string | null; unitId: string | undefined; ready: boolean }>({ key: null, unitId: undefined, ready: false });

  useEffect(() => {
    let cancelled = false;
    if (!key) {
      setState({ key, unitId: undefined, ready: true });
      return;
    }
    void preferences.get(key).then((stored) => {
      if (!cancelled) setState({ key, unitId: stored ?? undefined, ready: true });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const selectUnit = useCallback(
    (next: string | undefined) => {
      setState({ key, unitId: next, ready: true });
      if (key) void preferences.set(key, next ?? null);
    },
    [key],
  );

  const current = state.key === key ? state : { unitId: undefined, ready: false };
  return <PortalUnitContext value={{ unitId: current.unitId, ready: current.ready, selectUnit }}>{children}</PortalUnitContext>;
}

export function usePortalUnit(): PortalUnitValue {
  const ctx = use(PortalUnitContext);
  if (!ctx) throw new Error('usePortalUnit, PortalUnitProvider icinde kullanilmalidir');
  return ctx;
}
