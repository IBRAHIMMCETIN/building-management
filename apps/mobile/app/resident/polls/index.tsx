import { Stack } from 'expo-router';
import { UnitPicker } from '@/components/portal/UnitPicker';
import { PollsScreen } from '@/screens/resident/PollsScreen';

/** Oylamalar dairenin oy hakkina gore listelenir: birden fazla dairede ust cubukta daire secici. */
export default function PollsRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Oylamalar', headerRight: () => <UnitPicker /> }} />
      <PollsScreen />
    </>
  );
}
