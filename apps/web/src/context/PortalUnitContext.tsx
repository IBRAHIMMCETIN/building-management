import { type ReactNode, createContext, use, useCallback, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';

type PortalUnitValue = { unitId: string | undefined; selectUnit: (unitId: string | undefined) => void };

const PortalUnitContext = createContext<PortalUnitValue | null>(null);

const storageKey = (userId: string, apartmentId: string) => `bm.portal-unit.${userId}.${apartmentId}`;

/**
 * Birden fazla dairesi olan sakinin secili dairesi. Kullanici + apartman bazinda saklanir;
 * API her istekte daireyi kullanicinin uyelikleriyle yeniden dogrular (yetki burada degil).
 */
export function PortalUnitProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const key = user?.apartmentId ? storageKey(user.sub, user.apartmentId) : null;
  const [unitId, setUnitId] = useState<string | undefined>(() => {
    try {
      return (key && localStorage.getItem(key)) || undefined;
    } catch {
      return undefined;
    }
  });

  const selectUnit = useCallback(
    (next: string | undefined) => {
      setUnitId(next);
      try {
        if (!key) return;
        if (next) localStorage.setItem(key, next);
        else localStorage.removeItem(key);
      } catch {
        // depolama yoksa yalnizca bellekte
      }
    },
    [key],
  );

  return <PortalUnitContext value={{ unitId, selectUnit }}>{children}</PortalUnitContext>;
}

export function usePortalUnit(): PortalUnitValue {
  const ctx = use(PortalUnitContext);
  if (!ctx) throw new Error('usePortalUnit, PortalUnitProvider icinde kullanilmalidir');
  return ctx;
}
