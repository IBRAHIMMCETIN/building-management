import { Stack, useLocalSearchParams } from 'expo-router';
import { SearchX } from '@/components/icons';
import { EmptyState, Screen } from '@/components/ui';
import { useIsActiveOwner } from '@/hooks/useContexts';
import { residentMoreFor } from '@/lib/nav';
import { ComingSoonScreen } from '@/screens/ComingSoonScreen';

/** "Diğer" listesindeki, mobilde henuz olmayan ozellikler (M2): yer tutucu + web'de ac. */
export default function WebFeatureScreen() {
  const { feature } = useLocalSearchParams<{ feature: string }>();
  const item = residentMoreFor(useIsActiveOwner()).find((f) => f.key === feature);

  if (!item) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Bulunamadı' }} />
        <EmptyState icon={SearchX} title="Sayfa bulunamadı" description="Bu özellik bu hesap için kullanılamıyor." />
      </Screen>
    );
  }
  return (
    <>
      <Stack.Screen options={{ title: item.label }} />
      <ComingSoonScreen title={item.label} description={item.description} icon={item.icon} webPath={item.webPath} />
    </>
  );
}
