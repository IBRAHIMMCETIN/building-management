import { cn } from '@/lib/cn';

type Props<T extends string> = {
  label: string;
  value: T;
  options: readonly { value: T; label: string; count?: number }[];
  onChange: (value: T) => void;
};

/** Tek secimli filtre dugmeleri (aria-pressed). */
export function FilterChips<T extends string>({ label, value, options, onChange }: Props<T>) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface/60 px-3 py-1 text-xs font-medium text-muted transition-colors',
            'hover:bg-surface-muted hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
            value === o.value && 'border-accent/30 bg-accent/10 text-accent hover:bg-accent/15 hover:text-accent',
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="rounded-full bg-surface-muted px-1.5 tabular-nums">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
