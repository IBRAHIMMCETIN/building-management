import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/** Belirgin zemin + ince kenarlik; renk yalnizca durumu tasimaz, metin de tasir. */
const tones = {
  neutral: 'border-border-strong bg-surface-muted/60 text-muted',
  success: 'border-success/20 bg-success/10 text-success',
  warning: 'border-warning/20 bg-warning/10 text-warning',
  accent: 'border-accent/20 bg-accent/10 text-accent',
  danger: 'border-danger/20 bg-danger/10 text-danger',
} as const;

export function Badge({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: keyof typeof tones }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
