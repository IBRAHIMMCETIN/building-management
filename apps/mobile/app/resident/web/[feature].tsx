import { Stack, useLocalSearchParams } from 'expo-router';
import { SearchX } from '@/components/icons';
import { EmptyState, Screen } from '@/components/ui';
import { useContexts, useIsActiveOwner } from '@/hooks/useContexts';
import { RESIDENT_MORE } from '@/lib/nav';
import { ComingSoonScreen } from '@/screens/ComingSoonScreen';

/**
 * "Diğer" listesindeki, mobilde henuz olmayan ozellikler (M2): yer tutucu + web'de ac. Bildirimden
 * (`?id=`) gelinmisse web'de ayni kayit acilir (ornek: /app/oylamalar/<id>).
 */
export default function WebFeatureScreen() {
  const { feature, id } = useLocalSearchParams<{ feature: string; id?: string }>();
  const contexts = useContexts();
  const isOwner = useIsActiveOwner();
  const item = RESIDENT_MORE.find((f) => f.key === feature);
  // Maliklere ozel oge (Genel Kurul): baglamlar yuklenip malik olmadigi kesinlesince gizlenir.
  const hidden = !item || (item.ownersOnly && contexts.isSuccess && !isOwner);

  if (hidden) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Bulunamadı' }} />
        <EmptyState icon={SearchX} title="Sayfa bulunamadı" description="Bu özellik bu hesap için kullanılamıyor." />
      </Screen>
    );
  }
  const webPath = id ? `${item.webPath}/${encodeURIComponent(id)}` : item.webPath;
  return (
    <>
      <Stack.Screen options={{ title: item.label }} />
      <ComingSoonScreen title={item.label} description={item.description} icon={item.icon} webPath={webPath} />
    </>
  );
}
