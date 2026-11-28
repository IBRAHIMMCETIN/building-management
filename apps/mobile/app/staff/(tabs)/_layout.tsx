import { ClipboardList, ClipboardPen } from '@/components/icons';
import { FieldRoleTabs } from '@/navigation/StaffTabs';

/** Bina gorevlisi sekmeleri (web menusu: İşlerim, Sayaç Okuma) ve Hesabım. */
export default function StaffTabs() {
  return (
    <FieldRoleTabs
      tabs={[
        { name: 'index', title: 'İşlerim', icon: ClipboardList },
        { name: 'readings', title: 'Sayaç okuma', icon: ClipboardPen },
      ]}
    />
  );
}
