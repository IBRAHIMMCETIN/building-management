import { useLocalSearchParams } from 'expo-router';
import { TICKETS_FEATURE } from '@/lib/nav';
import { ComingSoonScreen } from '@/screens/ComingSoonScreen';

/** M2: talep listesi, arıza bildirme ve onay. Simdilik web'den (bildirimden gelinmisse ayni talep). */
export default function TicketsTab() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const webPath = id ? `${TICKETS_FEATURE.webPath}/${encodeURIComponent(id)}` : TICKETS_FEATURE.webPath;
  return <ComingSoonScreen title={TICKETS_FEATURE.label} description={TICKETS_FEATURE.description} icon={TICKETS_FEATURE.icon} webPath={webPath} />;
}
