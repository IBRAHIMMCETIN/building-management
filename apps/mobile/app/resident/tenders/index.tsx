import { Stack } from 'expo-router';
import { TendersScreen } from '@/screens/resident/TendersScreen';

export default function TendersRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'İhaleler' }} />
      <TendersScreen />
    </>
  );
}
