import { errorMessage } from '@bm/shared/api/errors';
import { useRouter } from 'expo-router';
import { Building2, LogOut } from '@/components/icons';
import { ContextList } from '@/components/ContextList';
import { Alert, AppText, Button, Card, EmptyState, Screen, Spinner } from '@/components/ui';
import { useAuth } from '@/context/AuthProvider';
import { useContexts, useSwitchContext } from '@/hooks/useContexts';
import { homeRouteFor } from '@/lib/auth/flow';

/**
 * Aktif apartman/rol secimi (web: pages/auth/SelectContextPage.tsx). Token'da rol claim'i yokken
 * zorunlu duraktir; rolu olan kullanici Hesabım'dan buraya gelip degistirebilir.
 */
export function SelectContextScreen() {
  const { user, signOut } = useAuth();
  const router = useRouter();
  const contexts = useContexts();
  const switcher = useSwitchContext();

  return (
    <Screen edges={user?.role ? 'bottom' : 'all'}>
      <Card>
        <AppText variant="heading" weight="semibold" accessibilityRole="header">
          Hangi apartmanla devam etmek istersiniz?
        </AppText>
        <AppText variant="small" tone="muted">
          Birden fazla apartmanda veya rolde yetkiniz var. Seçiminizi daha sonra Hesabım ekranından değiştirebilirsiniz.
        </AppText>

        {switcher.isError && <Alert tone="danger">{errorMessage(switcher.error)}</Alert>}
        {contexts.isPending && <Spinner label="Apartmanlarınız yükleniyor…" />}
        {contexts.isError && (
          <>
            <Alert tone="danger">{errorMessage(contexts.error)}</Alert>
            <Button variant="secondary" label="Tekrar dene" loading={contexts.isFetching} onPress={() => void contexts.refetch()} />
          </>
        )}
        {contexts.data && contexts.data.contexts.length === 0 && (
          <EmptyState
            icon={Building2}
            title="Henüz bir apartmana tanımlı değilsiniz"
            description="Apartman yöneticinizden sizi daireye veya göreve eklemesini isteyin, ardından tekrar giriş yapın."
          />
        )}
        {contexts.data && contexts.data.contexts.length > 0 && (
          <ContextList
            contexts={contexts.data.contexts}
            active={user}
            pending={switcher.isPending ? switcher.variables : null}
            disabled={switcher.isPending}
            onSelect={(ctx) =>
              switcher.mutate(ctx, {
                // Rol degismediyse (ornek: baska apartmanda yine sakin) korumali ekranlar degismez; acikca gidilir.
                onSuccess: (session) => router.replace(homeRouteFor(session.claims)),
              })
            }
          />
        )}

        <Button variant="ghost" icon={LogOut} label="Çıkış yap" onPress={() => void signOut()} />
      </Card>
    </Screen>
  );
}
