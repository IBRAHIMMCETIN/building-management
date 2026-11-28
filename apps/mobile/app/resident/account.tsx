import { AccountScreen } from '@/screens/account/AccountScreen';

/** "Diğer" listesinden acilir; baslik ust cubukta (yigin ekrani). */
export default function ResidentAccount() {
  return <AccountScreen showTitle={false} />;
}
