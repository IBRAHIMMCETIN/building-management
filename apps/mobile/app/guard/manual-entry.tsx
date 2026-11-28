import { useLocalSearchParams } from 'expo-router';
import { ManualEntryScreen } from '@/screens/guard/ManualEntryScreen';

export default function ManualEntryRoute() {
  const { plate } = useLocalSearchParams<{ plate?: string }>();
  return <ManualEntryScreen initialPlate={plate} />;
}
