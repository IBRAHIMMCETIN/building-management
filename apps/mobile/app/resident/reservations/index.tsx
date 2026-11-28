import { useLocalSearchParams } from 'expo-router';
import { ReservationsScreen } from '@/screens/resident/reservations/ReservationsScreen';

/**
 * Rezervasyon ("Diğer" listesinden). `?tab=mine`: rezervasyonlarim (bildirim /rezervasyonlar);
 * `&done=<id>&warning=`: yeni rezervasyonun sonucu (alan ekranindan donus).
 */
export default function ReservationsRoute() {
  const { tab, done, warning } = useLocalSearchParams<{ tab?: string; done?: string; warning?: string }>();
  return <ReservationsScreen tab={tab === 'mine' ? 'mine' : undefined} doneId={done || undefined} warning={warning || undefined} />;
}
