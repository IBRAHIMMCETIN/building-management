import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/** Yukleme yer tutucusu. Ekran okuyucudan gizlidir; durum metnini cagiran bilesen verir. */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-sm bg-surface-muted motion-reduce:animate-none', className)}
      {...props}
    />
  );
}
