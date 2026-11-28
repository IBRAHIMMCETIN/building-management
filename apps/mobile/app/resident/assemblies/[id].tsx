import { Stack, useLocalSearchParams } from 'expo-router';
import { AssemblyDetailScreen } from '@/screens/resident/AssemblyDetailScreen';

export default function AssemblyDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'Toplantı' }} />
      <AssemblyDetailScreen id={id ?? ''} />
    </>
  );
}
