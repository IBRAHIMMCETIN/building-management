import { Redirect } from 'expo-router';
import { useAuth } from '@/context/AuthProvider';
import { homeRouteFor } from '@/lib/auth/flow';

/** Acilis: oturum yok -> giris, rol yok -> baglam secimi, rol -> o rolun alani. */
export default function Index() {
  const { user } = useAuth();
  return <Redirect href={homeRouteFor(user)} />;
}
