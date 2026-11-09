import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const tones = {
  neutral: 'border-border text-muted',
  success: 'border-success/40 bg-success/10 text-success',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  accent: 'border-accent/40 bg-accent/10 text-accent',
} as const;

export function Badge({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: keyof typeof tones }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-small font-medium whitespace-nowrap', tones[tone], className)}
      {...props}
    />
  );
}
