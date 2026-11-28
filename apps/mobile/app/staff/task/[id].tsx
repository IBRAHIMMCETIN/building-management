import { useLocalSearchParams } from 'expo-router';
import { StaffTaskScreen } from '@/screens/staff/StaffTaskScreen';

export default function StaffTaskRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <StaffTaskScreen id={id ?? ''} />;
}
