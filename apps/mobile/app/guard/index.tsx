import { ScanLine } from '@/components/icons';
import { ComingSoonScreen } from '@/screens/ComingSoonScreen';

/** M3: QR gecis dogrulama, plaka sorgu, kurye / ziyaretci girisi. Simdilik web'den. */
export default function GateTab() {
  return (
    <ComingSoonScreen
      title="Kapı"
      description="Misafir geçiş kodu (QR) doğrulama, plaka sorgulama, kurye ve ziyaretçi girişi."
      icon={ScanLine}
      webPath="/admin/gate"
    />
  );
}
