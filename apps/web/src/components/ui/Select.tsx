import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export type SelectProps = ComponentProps<'select'> & { invalid?: boolean };

/** Yerel <select>: mobilde isletim sisteminin secicisi acilir (erisilebilir, hafif). */
export function Select({ className, invalid, children, ...props }: SelectProps) {
  return (
    <div className="relative">
      <select
        aria-invalid={invalid || undefined}
        className={cn(
          'h-10 w-full appearance-none rounded-md border border-border bg-surface pr-9 pl-3 text-body text-text',
          'focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none',
          'aria-invalid:border-danger disabled:opacity-60',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
    </div>
  );
}
