import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export type InputProps = ComponentProps<'input'> & { invalid?: boolean };

export function Input({ className, invalid, ...props }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(
        'h-10 w-full rounded-md border border-border bg-surface px-3 text-body text-text',
        'placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30',
        'aria-invalid:border-danger aria-invalid:focus:ring-danger/30',
        'disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}
