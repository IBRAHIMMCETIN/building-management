import { Landmark } from 'lucide-react';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { Card } from '@/components/ui';
import { ApiError } from '@/lib/api/errors';

/**
 * Genel kurul sorgusunun hata durumu. 403: bu sayfa yalnizca kat maliklerine aciktir (kiraci veya
 * uyeligi olmayan); PortalQueryState 403'u "daireye atanmadiniz" olarak gosterdigi icin burada
 * ayrica karsilanir. Diger hatalar portalin ortak durumuna gider (tekrar dene).
 */
export function AssemblyQueryState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof ApiError && error.status === 403) {
    return (
      <Card className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="grid size-12 place-items-center rounded-full bg-surface-muted text-accent">
          <Landmark className="size-6" aria-hidden="true" />
        </div>
        <p className="font-semibold">Genel kurul bilgileri kat maliklerine açıktır</p>
        <p className="text-small text-muted">Kat malikleri kurulu toplantıları, kararlar ve tutanaklar bu apartmanda malik olarak kayıtlı kullanıcılara gösterilir.</p>
      </Card>
    );
  }
  return <PortalQueryState error={error} onRetry={onRetry} />;
}
