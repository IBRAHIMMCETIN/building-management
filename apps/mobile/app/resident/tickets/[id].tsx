import { useLocalSearchParams } from 'expo-router';
import { TicketDetailScreen } from '@/screens/resident/tickets/TicketDetailScreen';

export default function TicketDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <TicketDetailScreen id={id ?? ''} />;
}
