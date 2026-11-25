import { CalendarCheck2, Lock } from 'lucide-react';
import { Link } from 'react-router';
import { Badge, Card } from '@/components/ui';

/**
 * Finans 2.4 - Mali donem kapanisi (UX-07 giris noktasi). Erisim: Finans okuma rolleri
 * (yonetici, yonetim firmasi, denetci); kapanis islemleri yazma rollerine acilacak.
 *
 * Bu sekme yol haritasindaki "donem kapama + butce" modulunun yeridir. Backend ucu (donem kilidi,
 * kapanis mizani, devir) henuz yoktur; bu yuzden burada islem yapan bir arayuz SUNULMAZ.
 * Bugun yururlukte olan tek kilit cari bazli tasinma kapamasidir (Ayrilan cariler sekmesi).
 */
export function PeriodClosingPanel() {
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <CalendarCheck2 className="size-5 text-muted" aria-hidden="true" />
        <h2 className="font-semibold">Dönem kapanışı</h2>
        <Badge tone="accent">Finans 2.4 · hazırlanıyor</Badge>
      </div>
      <p className="text-small text-muted">
        Mali dönem kapanışı; seçilen ayın defterini kilitler (kapalı döneme tahakkuk, tahsilat veya ters kayıt yazılamaz), kapanış mizanını ve
        bütçe–gerçekleşen karşılaştırmasını PDF olarak üretir. Modül tamamlandığında bu sekmeden yönetilecektir.
      </p>
      <ul className="flex flex-col gap-2 text-small">
        <li className="flex items-start gap-2">
          <Lock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
          <span>
            Bugün yürürlükte olan kilit cari bazlıdır: taşınma kapaması yapılan carilere kapanış tarihinden önceye kayıt yazılamaz (
            <Link className="text-accent underline-offset-4 hover:underline" to="/admin/finance?tab=former">
              Ayrılan cariler
            </Link>
            ).
          </span>
        </li>
      </ul>
    </Card>
  );
}
