import { useLocalSearchParams } from 'expo-router';
import { StaffTicketScreen } from '@/screens/staff/StaffTicketScreen';

export default function StaffTicketRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <StaffTicketScreen id={id ?? ''} />;
}
