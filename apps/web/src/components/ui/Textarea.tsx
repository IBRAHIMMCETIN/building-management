import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export type TextareaProps = ComponentProps<'textarea'> & { invalid?: boolean };

/** Cok satirli metin; Input ile ayni gorunum ve FormField uyumu (invalid / aria-describedby). */
export function Textarea({ className, invalid, rows = 6, ...props }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(
        'w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-body text-text',
        'placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30',
        'aria-invalid:border-danger aria-invalid:focus:ring-danger/30',
        'disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}
