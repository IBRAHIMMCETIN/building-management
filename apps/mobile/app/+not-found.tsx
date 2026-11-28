import { useRouter } from 'expo-router';
import { SearchX } from '@/components/icons';
import { Button, EmptyState, Screen } from '@/components/ui';

/** Bilinmeyen adres (derin baglanti / web onizlemesi). */
export default function NotFound() {
  const router = useRouter();
  return (
    <Screen edges="all">
      <EmptyState icon={SearchX} title="Sayfa bulunamadı" description="Aradığınız sayfa taşınmış veya kaldırılmış olabilir." />
      <Button label="Ana sayfaya dön" align="center" onPress={() => router.replace('/')} />
    </Screen>
  );
}
