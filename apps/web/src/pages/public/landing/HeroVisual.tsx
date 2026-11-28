import { DoorOpen, Wrench } from 'lucide-react';
import { Badge, Card } from '@/components/ui';
import { cn } from '@/lib/cn';

/*
 * Kahraman alanindaki urun gorseli: uygulamanin kendi kart, rozet ve renk token'lariyla cizilmis
 * temsili bir Genel Bakis. Bloklarin pencereleri bagimsiz bolumlerdir; renk bu ayin aidat durumunu
 * gosterir (isim yok: borclu isimleri hicbir yerde listelenmez). Veriler ornektir ve sabittir
 * (sunucuda on-render edilen HTML ile tarayicidaki ilk render ayni olmali).
 */

type UnitState = 'paid' | 'pending' | 'empty';

const BLOCKS = [
  { name: 'A Blok', floors: 6, seed: 1 },
  { name: 'B Blok', floors: 8, seed: 4 },
  { name: 'C Blok', floors: 5, seed: 7 },
] as const;
const UNITS_PER_FLOOR = 4;

function unitState(seed: number, index: number): UnitState {
  const v = (index * 7 + seed * 3) % 11;
  if (v === 10) return 'empty';
  return v >= 8 ? 'pending' : 'paid';
}

const UNIT_CLASS: Record<UnitState, string> = {
  paid: 'bg-accent',
  pending: 'bg-brand-orange',
  empty: 'border border-border-strong bg-surface',
};

const LEGEND: readonly { state: UnitState; label: string }[] = [
  { state: 'paid', label: 'Ödendi' },
  { state: 'pending', label: 'Ödeme bekleniyor' },
  { state: 'empty', label: 'Boş daire' },
];

const blocks = BLOCKS.map((b) => ({ ...b, units: Array.from({ length: b.floors * UNITS_PER_FLOOR }, (_, i) => unitState(b.seed, i)) }));
const allUnits = blocks.flatMap((b) => b.units);
const charged = allUnits.filter((u) => u !== 'empty').length;
const paid = allUnits.filter((u) => u === 'paid').length;
const paidPercent = Math.round((paid / charged) * 100);

export function HeroVisual({ className }: { className?: string }) {
  return (
    <figure className={cn('relative', className)}>
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Card className="flex flex-col gap-5 lg:pb-16">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-text">Örnek Sitesi</p>
              <p className="text-small text-muted">
                {blocks.length} blok, {allUnits.length} bağımsız bölüm
              </p>
            </div>
            <Badge tone="accent">Örnek veri</Badge>
          </div>

          <div>
            <div className="grid grid-cols-3 items-end justify-items-center border-b-2 border-border-strong">
              {blocks.map((b) => (
                <div key={b.name} className="grid grid-cols-4 gap-1 rounded-t-md border border-b-0 border-border-strong bg-surface-muted p-1.5 sm:gap-1.5 sm:p-2">
                  {b.units.map((u, i) => (
                    <span key={i} className={cn('h-3 w-3.5 rounded-sm sm:h-3.5 sm:w-5', UNIT_CLASS[u])} />
                  ))}
                </div>
              ))}
            </div>
            <div className="mt-1.5 grid grid-cols-3 justify-items-center">
              {blocks.map((b) => (
                <p key={b.name} className="text-xs font-medium text-muted">
                  {b.name}
                </p>
              ))}
            </div>
          </div>

          <div className="flex items-end justify-between gap-4 border-t border-border pt-4">
            <div>
              <p className="text-small whitespace-nowrap text-muted">Bu ay tahsilat</p>
              <p className="text-2xl font-semibold tabular-nums">%{paidPercent}</p>
            </div>
            <ul className="flex flex-col gap-1 text-xs text-text-secondary">
              {LEGEND.map((l) => (
                <li key={l.state} className="flex items-center gap-1.5">
                  <span className={cn('size-3 rounded-sm', UNIT_CLASS[l.state])} />
                  {l.label}
                </li>
              ))}
            </ul>
          </div>
        </Card>

        <div className="grid gap-3 sm:grid-cols-2 lg:-mt-14 lg:gap-4 lg:px-5">
          <Card className="flex items-start gap-3 p-4 md:p-4">
            <Wrench className="mt-0.5 size-5 shrink-0 text-accent" />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-small font-medium text-text">Asansör arızası, B Blok</p>
              <p className="text-xs text-muted">Görevliye atandı, bugün 14:00</p>
              <Badge tone="warning" className="self-start">
                İşlemde
              </Badge>
            </div>
          </Card>
          <Card className="flex items-start gap-3 p-4 md:p-4">
            <DoorOpen className="mt-0.5 size-5 shrink-0 text-accent" />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-small font-medium text-text">Kurye kapıda, C Blok 12</p>
              <p className="text-xs text-muted">Sakin onayladı: içeri alınsın</p>
              <Badge tone="success" className="self-start">
                Onaylandı
              </Badge>
            </div>
          </Card>
        </div>
      </div>
      <figcaption className="mt-4 text-xs text-muted">
        Temsilî ekran, örnek verilerle: blok blok aidat durumu, açık arıza talebi ve kapıdaki kurye.
      </figcaption>
    </figure>
  );
}
