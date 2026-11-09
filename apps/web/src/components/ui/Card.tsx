import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

type CardProps = ComponentProps<'section'> & {
  /** Liste kartlari: uzerine gelince kenarlik belirginlesir. */
  interactive?: boolean;
};

/** Hafif derinlikli yuzey: yari saydam zemin + bulaniklik + ince kenarlik. */
export function Card({ className, interactive, ...props }: CardProps) {
  return (
    <section
      className={cn(
        'rounded-xl border border-border bg-surface/60 p-5 shadow-sm backdrop-blur-sm md:p-6',
        interactive && 'transition-colors hover:border-border-strong',
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-base font-semibold text-text md:text-lg', className)} {...props} />;
}
