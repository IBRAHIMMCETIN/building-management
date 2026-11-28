import { ClipboardList } from '@/components/icons';
import { ComingSoonScreen } from '@/screens/ComingSoonScreen';

/** M3: size atanan ariza ve bakim isleri, sayac okuma. Simdilik web'den. */
export default function MyTasksTab() {
  return (
    <ComingSoonScreen
      title="İşlerim"
      description="Size atanan arıza ve bakım işleri, durum güncelleme ve sayaç okuma."
      icon={ClipboardList}
      webPath="/admin/my-tasks"
    />
  );
}
