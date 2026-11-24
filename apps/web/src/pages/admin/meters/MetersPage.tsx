import { ClipboardPen } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { Alert } from '@/components/ui';
import { useMeterPermissions } from '@/hooks/useMeters';
import { cn } from '@/lib/cn';
import { MeterRegistryPanel } from './MeterRegistryPanel';
import { PeriodDetail } from './PeriodDetail';
import { PeriodsPanel } from './PeriodsPanel';
import { TemplatesPanel } from './TemplatesPanel';

const TABS = [
  { id: 'periods', label: 'Dönemler' },
  { id: 'meters', label: 'Sayaçlar' },
  { id: 'templates', label: 'Şablonlar' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/**
 * Sayac / endeks dagitimi (Finans 2.3): sicil, dagitim sablonlari, donemler. Donem ayrintisi
 * `?period=<id>` ile acilir (paylasilabilir / geri tusu calisir).
 */
export function MetersPage() {
  const { canRead, canWriteReadings } = useMeterPermissions();
  const [params, setParams] = useSearchParams();
  const tab: TabId = TABS.find((t) => t.id === params.get('tab'))?.id ?? 'periods';
  const periodId = params.get('period');

  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-title font-bold">Sayaç Dağıtımı</h1>
        <Alert>Bu rol sayaç dağıtım kayıtlarını görüntüleyemez.</Alert>
      </div>
    );
  }

  const selectTab = (id: TabId) => setParams(id === 'periods' ? {} : { tab: id });
  const openPeriod = (id: string) => setParams({ period: id });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-title font-bold">Sayaç Dağıtımı</h1>
          <p className="text-small text-muted">Isınma ve su giderinin ortak pay + tüketim esasına göre dağıtımı: okuma, önizleme, onay ve geri alma.</p>
        </div>
        {canWriteReadings && (
          <Link to="/admin/meter-readings" className="inline-flex items-center gap-2 text-small font-medium text-accent underline-offset-4 hover:underline">
            <ClipboardPen className="size-4" aria-hidden="true" />
            Hızlı okuma girişi (mobil)
          </Link>
        )}
      </div>

      {periodId ? (
        <PeriodDetail periodId={periodId} onBack={() => setParams({})} onOpen={openPeriod} />
      ) : (
        <div className="flex flex-col gap-4">
          <div role="tablist" aria-label="Sayaç dağıtımı görünümü" className="flex gap-1 border-b border-border">
            {TABS.map((t) => (
              <button
                key={t.id}
                id={`tab-${t.id}`}
                role="tab"
                type="button"
                aria-selected={tab === t.id}
                aria-controls={`panel-${t.id}`}
                onClick={() => selectTab(t.id)}
                className={cn(
                  '-mb-px border-b-2 border-transparent px-4 py-2 text-small font-medium text-muted hover:text-text',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  tab === t.id && 'border-accent text-accent',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
            {tab === 'periods' && <PeriodsPanel onOpen={openPeriod} />}
            {tab === 'meters' && <MeterRegistryPanel />}
            {tab === 'templates' && <TemplatesPanel />}
          </div>
        </div>
      )}
    </div>
  );
}
