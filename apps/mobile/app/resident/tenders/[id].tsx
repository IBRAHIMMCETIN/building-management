import { Stack, useLocalSearchParams } from 'expo-router';
import { TenderDetailScreen } from '@/screens/resident/TenderDetailScreen';

export default function TenderDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'İhale' }} />
      <TenderDetailScreen id={id ?? ''} />
    </>
  );
}
