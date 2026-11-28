import { type ReactNode, createContext, use, useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useContexts } from '@/hooks/useContexts';

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

/**
 * Baska bir yuzeyden (mobil uygulama "Online öde" -> `/app/odeme?unitId=`) istenen daire. Kullanicinin
 * aktif sakin baglamindaki dairelerinden biriyse secilir (secici gibi saklanir); degilse yok sayilir.
 * `pending`: baglam listesi yuklenirken veya secim henuz uygulanmamisken (sayfa eski dairenin
 * verisini gostermesin). Istek yoksa davranis degismez. Yetkinin asli yine API'dedir.
 */
export function useRequestedUnit(requested: string | null | undefined): { pending: boolean } {
  const { unitId, selectUnit } = usePortalUnit();
  const { user } = useAuth();
  const contexts = useContexts();
  const units = contexts.data?.contexts.find((c) => c.apartmentId === user?.apartmentId && c.role === 'resident')?.units ?? [];
  const valid = !!requested && units.some((u) => u.unitId === requested);

  useEffect(() => {
    if (valid && requested && requested !== unitId) selectUnit(requested);
  }, [valid, requested, unitId, selectUnit]);

  if (!requested) return { pending: false };
  if (contexts.isPending) return { pending: true };
  return { pending: valid && unitId !== requested };
}
