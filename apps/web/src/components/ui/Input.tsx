import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export type InputProps = ComponentProps<'input'> & { invalid?: boolean };

export function Input({ className, invalid, ...props }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(
        'h-10 w-full rounded-md border border-border-strong bg-surface/80 px-3 text-small text-text shadow-xs transition-colors',
        'placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20',
        'aria-invalid:border-danger aria-invalid:focus:ring-danger/20',
        'disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}
