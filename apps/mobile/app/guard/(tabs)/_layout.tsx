import { ScanLine } from '@/components/icons';
import { FieldRoleTabs } from '@/navigation/StaffTabs';

/** Guvenlik gorevlisi sekmeleri: Kapı ve Hesabım. */
export default function GuardTabs() {
  return <FieldRoleTabs tabs={[{ name: 'index', title: 'Kapı', icon: ScanLine }]} />;
}
