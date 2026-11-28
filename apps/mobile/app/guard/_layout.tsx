import { ScanLine } from '@/components/icons';
import { FieldRoleTabs } from '@/navigation/StaffTabs';

/** Guvenlik gorevlisi: Kapı (M3) ve Hesabım. */
export default function GuardLayout() {
  return <FieldRoleTabs mainTitle="Kapı" mainIcon={ScanLine} />;
}
