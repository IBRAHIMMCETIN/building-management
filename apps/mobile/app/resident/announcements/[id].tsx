import { useLocalSearchParams } from 'expo-router';
import { AnnouncementDetailScreen } from '@/screens/resident/AnnouncementDetailScreen';

export default function AnnouncementDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AnnouncementDetailScreen id={id ?? ''} />;
}
