import { act, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { useActiveApartmentName, useIsActiveOwner } from '@/hooks/useContexts';
import { renderApp } from '@/test/renderApp';
import { useAuth } from './AuthProvider';

function ActiveContext() {
  const { user } = useAuth();
  const name = useActiveApartmentName();
  const owner = useIsActiveOwner();
  return <Text>{`${user?.role ?? 'rol yok'} | ${name ?? 'ad yok'} | ${owner ? 'malik' : 'malik degil'}`}</Text>;
}

describe('oturum kapsami ve onbellek', () => {
  it('baglam degisince acik kalan bilesen yeni baglamin verisine baglanir (eski sorguda takilmaz)', async () => {
    const { services } = await renderApp(<ActiveContext />, { email: 'multi@dev.local' });
    expect(await screen.findByText('rol yok | ad yok | malik degil')).toBeTruthy();

    await act(async () => {
      await services.session.setActiveContext({ apartmentId: 'apt-dev-2', role: 'resident' });
    });
    expect(await screen.findByText('resident | Çınar Apartmanı | malik degil')).toBeTruthy();

    await act(async () => {
      await services.session.setActiveContext({ apartmentId: 'apt-dev-1', role: 'resident' });
    });
    // apt-dev-1'de Daire 3 maliki: Genel Kurul ogesi icin malik bilgisi de guncellenir.
    expect(await screen.findByText('resident | Geliştirme Sitesi | malik')).toBeTruthy();
  });

  it('cikista onceki kullanicinin onbellegi, oturum degismeden once temizlenir', async () => {
    const { services, queryClient } = await renderApp(<ActiveContext />, { email: 'resident@dev.local' });
    await screen.findByText('resident | Geliştirme Sitesi | malik degil');
    queryClient.setQueryData(['apartment', 'apt-dev-1', 'portal', 'mock-resident', 'summary', 'auto'], { gizli: true });

    let cacheSizeWhenNotified = -1;
    services.session.subscribe(() => {
      if (!services.session.getSession()) cacheSizeWhenNotified = queryClient.getQueryCache().getAll().length;
    });
    await act(async () => {
      await services.session.signOut();
    });
    expect(cacheSizeWhenNotified).toBe(0);
  });

  it('girisle yeni kullanici bos onbellekle baslar; bekleyen mutasyonlar silinir', async () => {
    const { services, queryClient } = await renderApp(<Text>giris</Text>, { email: null, withUnit: false });
    queryClient.setQueryData(['me', 'contexts', 'onceki-kullanici'], { contexts: [] });
    queryClient.getMutationCache().build(queryClient, { mutationFn: async () => undefined });

    let seen: { queries: number; mutations: number } | null = null;
    services.session.subscribe(() => {
      if (services.session.getSession()) seen ??= { queries: queryClient.getQueryCache().getAll().length, mutations: queryClient.getMutationCache().getAll().length };
    });
    await act(async () => {
      await services.session.signIn({ email: 'resident@dev.local', password: 'x' });
    });
    expect(seen).toEqual({ queries: 0, mutations: 0 });
  });

  it('token yenilemesi (ayni kapsam) onbellegi silmez', async () => {
    const { services, queryClient } = await renderApp(<ActiveContext />, { email: 'resident@dev.local' });
    await screen.findByText('resident | Geliştirme Sitesi | malik degil');
    await act(async () => {
      await services.session.refresh();
    });
    await waitFor(() => expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0));
  });
});
