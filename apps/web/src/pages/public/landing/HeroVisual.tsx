import { Check, CircleCheck } from 'lucide-react';
import { Card } from '@/components/ui';
import { cn } from '@/lib/cn';
import { PhoneFrame, RESIDENT_TABS, ReferenceMark, ResidentPortalScreen, SAMPLE_REFERENCE, SampleBadge } from './PhoneVisual';

/*
 * Kahraman alanindaki urun gorseli: bir havalenin yolu. Sakin telefonda IBAN'i ve kendi referans
 * kodunu (R4T7KD) kopyalar; yonetim panelinde banka ekstresindeki ayni kodlu satir "A Blok 12"
 * dairesine ONERILIR (urunde oldugu gibi: kod eslesmesi yalnizca oneridir, odeme yonetici satir satir
 * veya toplu onaylayinca islenir). Altta 4 blok, 216 bagimsiz bolum: pencereler dairelerdir, renk bu ayin
 * aidat durumudur (isim yok: borclu isimleri hicbir yerde gosterilmez). Uygulamanin kendi kart, rozet
 * ve renk token'lariyla cizilir; veriler ornektir ve sabittir (on-render HTML'i ile ilk render ayni).
 */

type UnitState = 'paid' | 'pending' | 'empty';

const FLOORS = 9;
const UNITS_PER_FLOOR = 6;
const BLOCKS = [
  { name: 'A', seed: 1 },
  { name: 'B', seed: 4 },
  { name: 'C', seed: 7 },
  { name: 'D', seed: 2 },
] as const;
/** Ekstrede onerilen ornek odemenin dairesi: A Blok 12 (onay bekledigi icin henuz "Bekliyor"). */
const MATCHED = { block: 'A', index: 11 } as const;

function unitState(seed: number, index: number): UnitState {
  const v = (index * 7 + seed * 5) % 13;
  if (v === 12) return 'empty';
  return v >= 10 ? 'pending' : 'paid';
}

const blocks = BLOCKS.map((b) => ({
  ...b,
  units: Array.from({ length: FLOORS * UNITS_PER_FLOOR }, (_, i) => (b.name === MATCHED.block && i === MATCHED.index ? 'pending' : unitState(b.seed, i))),
}));
const allUnits = blocks.flatMap((b) => b.units);
const charged = allUnits.filter((u) => u !== 'empty').length;
const paidPercent = Math.round((allUnits.filter((u) => u === 'paid').length / charged) * 100);

const UNIT_CLASS: Record<UnitState, string> = {
  paid: 'bg-accent',
  pending: 'bg-brand-orange',
  empty: 'border border-border-strong bg-surface',
};

const LEGEND: readonly { state: UnitState; label: string }[] = [
  { state: 'paid', label: 'Ödendi' },
  { state: 'pending', label: 'Bekliyor' },
  { state: 'empty', label: 'Boş' },
];

/** Ekstre satiri: referans koduyla oneri (onay bekler), onaylanip islenmis, kodsuz (elle eslenecek). */
type StatementLine = { id: string; text: string; amount: string; state: 'suggested' | 'posted' | 'manual'; unit?: string };

const STATEMENT: readonly StatementLine[] = [
  { id: 'oneri', text: 'AİDAT', amount: '₺1.500,50', state: 'suggested', unit: 'A Blok 12' },
  { id: 'islendi', text: 'EFT M2Q9XC AİDAT', amount: '₺1.500,50', state: 'posted', unit: 'C Blok 4' },
  { id: 'kodsuz', text: 'HAVALE AİDAT ÖDEMESİ', amount: '₺1.350,00', state: 'manual' },
];

function ManagerPanel() {
  return (
    <Card className="flex flex-col gap-5 p-4 sm:pr-14 md:p-5 md:pr-16">
      <div className="flex items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="font-semibold text-text">Örnek Sitesi</p>
          <p className="text-small text-muted">Yönetim paneli</p>
        </div>
        <SampleBadge />
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-small font-semibold text-text">Banka ekstresi</p>
          <p className="text-xs text-muted">Bugün yüklendi: 1 öneri onayınızı bekliyor</p>
        </div>
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
          {STATEMENT.map((line) => (
            <li key={line.id} className={cn('flex items-start justify-between gap-3 px-3 py-2.5', line.state === 'suggested' && 'bg-accent/5')}>
              <div className="flex min-w-0 flex-col gap-1">
                <p className="truncate font-mono text-xs text-text-secondary">
                  {line.state === 'suggested' ? (
                    <>
                      EFT <ReferenceMark />{' '}
                    </>
                  ) : null}
                  {line.text}
                </p>
                {line.state === 'suggested' && <p className="text-xs font-medium text-text">Öneri: {line.unit}</p>}
                {line.state === 'posted' && (
                  <p className="flex items-center gap-1 text-xs font-medium text-success">
                    <CircleCheck className="size-3.5 shrink-0" />
                    Onaylandı, {line.unit} hesabına işlendi
                  </p>
                )}
                {line.state === 'manual' && (
                  <p className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
                    <span className="size-2 shrink-0 rounded-full bg-brand-orange" />
                    Kod yok, elle eşleyin
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <p className="text-small font-semibold text-text tabular-nums">{line.amount}</p>
                {line.state === 'suggested' && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-on-primary">
                    <Check className="size-3.5" />
                    Onayla
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-small font-semibold text-text">Bu ayın aidatı</p>
          <p className="text-xs text-muted">
            {blocks.length} blok, {allUnits.length} bağımsız bölüm
          </p>
        </div>
        <div className="grid grid-cols-4 items-end gap-2 border-b-2 border-border-strong sm:gap-3">
          {blocks.map((b) => (
            <div key={b.name} className="grid grid-cols-6 gap-0.5 rounded-t-md border border-b-0 border-border-strong bg-surface-muted p-1">
              {b.units.map((u, i) => (
                <span
                  key={i}
                  className={cn('aspect-square', UNIT_CLASS[u], b.name === MATCHED.block && i === MATCHED.index && 'relative z-10 outline-2 outline-offset-1 outline-text')}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-4 gap-2 sm:gap-3">
          {blocks.map((b) => (
            <p key={b.name} className="text-center text-xs font-medium text-muted">
              {b.name} Blok
            </p>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="text-small text-text-secondary">
            Tahsilat <strong className="text-heading font-semibold text-text tabular-nums">%{paidPercent}</strong>
          </p>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary">
            {LEGEND.map((l) => (
              <li key={l.state} className="flex items-center gap-1.5">
                <span className={cn('size-2.5', UNIT_CLASS[l.state])} />
                {l.label}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

/**
 * Yonetim paneli + sakin telefonu. Dar ekranda (sm alti) yalnizca panel: telefon ekranlari Mobil
 * bolumunde. Telefon panelin sag ic boslugunun ustune biner; panelin icerigini ortmez.
 */
export function HeroVisual({ className }: { className?: string }) {
  return (
    <figure className={cn('flex flex-col gap-4', className)}>
      <div aria-hidden="true" className="flex items-start">
        <div className="min-w-0 flex-1">
          <ManagerPanel />
        </div>
        <div className="relative z-10 -ml-10 hidden pt-16 sm:block md:-ml-12">
          <PhoneFrame tabs={RESIDENT_TABS} className="[zoom:0.7] xl:[zoom:0.66]">
            <ResidentPortalScreen />
          </PhoneFrame>
        </div>
      </div>
      <figcaption className="text-xs text-muted">
        Örnek veri: sakin {SAMPLE_REFERENCE} referans koduyla havale yapar; banka ekstresi yüklenince ödeme A Blok 12’ye önerilir, yönetici
        onaylayınca işlenir ve daire “Ödendi” olur.
      </figcaption>
    </figure>
  );
}
