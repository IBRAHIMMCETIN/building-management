import { Building2, LogOut } from 'lucide-react';
import { useNavigate } from 'react-router';
import { ContextList } from '@/components/context/ContextList';
import { Alert, Button, Card, CardTitle, Spinner } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { useContexts, useSwitchContext } from '@/hooks/useContexts';
import { errorMessage } from '@/lib/api/errors';

/**
 * Giris sonrasi aktif apartman/rol secimi. Token'da rol claim'i yokken (birden fazla
 * apartman, tercih yok) zorunlu duraktir; rolu olan kullanici da buradan degistirebilir.
 */
export function SelectContextPage() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const contexts = useContexts();
  const switcher = useSwitchContext();

  const logout = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <Card className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <CardTitle>Hangi apartmanla devam etmek istersiniz?</CardTitle>
        <p className="text-small text-muted">
          Birden fazla apartmanda veya rolde yetkiniz var. Seçiminizi daha sonra üst menüden değiştirebilirsiniz.
        </p>
      </div>

      {switcher.isError && <Alert tone="danger">{errorMessage(switcher.error)}</Alert>}

      {contexts.isPending && <Spinner label="Apartmanlarınız yükleniyor…" />}

      {contexts.isError && (
        <div className="flex flex-col gap-3">
          <Alert tone="danger">{errorMessage(contexts.error)}</Alert>
          <Button variant="secondary" onClick={() => void contexts.refetch()} loading={contexts.isFetching}>
            Tekrar dene
          </Button>
        </div>
      )}

      {contexts.data && contexts.data.contexts.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <Building2 className="size-8 text-muted" aria-hidden="true" />
          <p className="font-medium">Henüz bir apartmana tanımlı değilsiniz</p>
          <p className="text-small text-muted">
            Apartman yöneticinizden sizi daireye veya göreve eklemesini isteyin, ardından tekrar giriş yapın.
          </p>
        </div>
      )}

      {contexts.data && contexts.data.contexts.length > 0 && (
        <ContextList
          contexts={contexts.data.contexts}
          active={user}
          pending={switcher.isPending ? switcher.variables : null}
          disabled={switcher.isPending}
          onSelect={(ctx) => switcher.mutate(ctx)}
        />
      )}

      <Button variant="ghost" size="sm" className="self-start" onClick={logout}>
        <LogOut className="size-4" aria-hidden="true" />
        Çıkış yap
      </Button>
    </Card>
  );
}
