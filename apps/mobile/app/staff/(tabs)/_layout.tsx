import { ClipboardList } from '@/components/icons';
import { FieldRoleTabs } from '@/navigation/StaffTabs';

/** Bina gorevlisi sekmeleri: İşlerim ve Hesabım. */
export default function StaffTabs() {
  return <FieldRoleTabs tabs={[{ name: 'index', title: 'İşlerim', icon: ClipboardList }]} />;
}
