import { useLocalSearchParams } from 'expo-router';
import { FacilityBookingScreen } from '@/screens/resident/reservations/FacilityBookingScreen';

export default function FacilityBookingRoute() {
  const { facilityId } = useLocalSearchParams<{ facilityId: string }>();
  return <FacilityBookingScreen facilityId={facilityId ?? ''} />;
}
