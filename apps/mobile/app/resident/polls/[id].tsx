import { Stack, useLocalSearchParams } from 'expo-router';
import { UnitPicker } from '@/components/portal/UnitPicker';
import { PollDetailScreen } from '@/screens/resident/PollDetailScreen';

export default function PollDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'Oylama', headerRight: () => <UnitPicker /> }} />
      <PollDetailScreen id={id ?? ''} />
    </>
  );
}
