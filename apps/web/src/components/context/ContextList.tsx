import { Building2, Check, ChevronRight, LoaderCircle } from 'lucide-react';
import type { SelectableContext } from '@/lib/auth/contexts';
import type { ActiveContext } from '@/lib/auth/session';
import { cn } from '@/lib/cn';
import { ROLE_LABELS } from '@/types/roles';

const RELATION_LABELS = { owner: 'Malik', tenant: 'Kiracı' } as const;

/** "Kiracı · Daire 12", birden fazla dairede "Malik · Daire 3, 4" */
function describe(ctx: SelectableContext): string {
  if (ctx.role !== 'resident' || !ctx.units?.length) return ROLE_LABELS[ctx.role];
  const relations = [...new Set(ctx.units.map((u) => RELATION_LABELS[u.relation]))].join(' / ');
  const numbers = ctx.units.map((u) => u.unitNumber).filter(Boolean);
  return numbers.length ? `${relations} · Daire ${numbers.join(', ')}` : relations;
}

type Props = {
  contexts: SelectableContext[];
  active?: { apartmentId?: string; role?: string } | null;
  pending?: ActiveContext | null;
  disabled?: boolean;
  onSelect: (context: ActiveContext) => void;
};

/** Baglamlari apartmana gore gruplar; her rol ayri secilebilir satirdir. */
export function ContextList({ contexts, active, pending, disabled, onSelect }: Props) {
  const groups = new Map<string, { name: string; items: SelectableContext[] }>();
  for (const ctx of contexts) {
    const group = groups.get(ctx.apartmentId) ?? { name: ctx.apartmentName, items: [] };
    group.items.push(ctx);
    groups.set(ctx.apartmentId, group);
  }

  return (
    <div className="flex flex-col gap-4">
      {[...groups].map(([apartmentId, group]) => (
        <section key={apartmentId} aria-labelledby={`apt-${apartmentId}`} className="flex flex-col gap-2">
          <h3 id={`apt-${apartmentId}`} className="flex items-center gap-2 text-small font-semibold text-muted">
            <Building2 className="size-4" aria-hidden="true" />
            {group.name}
          </h3>
          <ul className="flex flex-col gap-2">
            {group.items.map((ctx) => {
              const isActive = active?.apartmentId === ctx.apartmentId && active.role === ctx.role;
              const isPending = pending?.apartmentId === ctx.apartmentId && pending.role === ctx.role;
              return (
                <li key={ctx.role}>
                  <button
                    type="button"
                    disabled={disabled || isActive}
                    aria-current={isActive || undefined}
                    onClick={() => onSelect({ apartmentId: ctx.apartmentId, role: ctx.role })}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3 text-left',
                      'hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                      'disabled:cursor-default disabled:hover:border-border',
                      isActive && 'border-accent bg-surface-muted disabled:hover:border-accent',
                    )}
                  >
                    <span className="flex flex-col">
                      <span className="font-medium">{ROLE_LABELS[ctx.role]}</span>
                      {ctx.role === 'resident' && <span className="text-small text-muted">{describe(ctx)}</span>}
                    </span>
                    {isPending ? (
                      <LoaderCircle className="size-4 animate-spin text-muted" aria-label="Geçiliyor" />
                    ) : isActive ? (
                      <span className="flex items-center gap-1 text-small text-accent">
                        <Check className="size-4" aria-hidden="true" />
                        Aktif
                      </span>
                    ) : (
                      <ChevronRight className="size-4 text-muted" aria-hidden="true" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
