import { ComingSoonScreen } from '@/screens/ComingSoonScreen';
import { TICKETS_FEATURE } from '@/lib/nav';

/** M2: talep listesi, arıza bildirme ve onay. Simdilik web'den. */
export default function TicketsTab() {
  return <ComingSoonScreen title={TICKETS_FEATURE.label} description={TICKETS_FEATURE.description} icon={TICKETS_FEATURE.icon} webPath={TICKETS_FEATURE.webPath} />;
}
