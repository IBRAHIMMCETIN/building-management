import { ClipboardList } from '@/components/icons';
import { FieldRoleTabs } from '@/navigation/StaffTabs';

/** Bina gorevlisi: İşlerim (M3) ve Hesabım. */
export default function StaffLayout() {
  return <FieldRoleTabs mainTitle="İşlerim" mainIcon={ClipboardList} />;
}
