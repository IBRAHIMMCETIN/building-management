import { useIsFocused } from 'expo-router';
import { GateScreen } from '@/screens/guard/GateScreen';

/** Kapı sekmesi: sekme gorunmezken kamera kapali, kurye listesi yenilenmez. */
export default function GateTab() {
  const focused = useIsFocused();
  return <GateScreen active={focused} />;
}
