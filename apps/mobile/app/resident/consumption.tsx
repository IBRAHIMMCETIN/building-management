import { Stack } from 'expo-router';
import { UnitPicker } from '@/components/portal/UnitPicker';
import { ConsumptionScreen } from '@/screens/resident/ConsumptionScreen';

/** Tüketim daire bazlidir: birden fazla dairede ust cubukta daire secici. */
export default function ConsumptionRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Tüketimim', headerRight: () => <UnitPicker /> }} />
      <ConsumptionScreen />
    </>
  );
}
