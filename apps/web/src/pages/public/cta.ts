import { cn } from '@/lib/cn';

/**
 * Buton gibi gorunen baglanti (<a>): tanitim ve hukuki sayfalarda gezinme eylemleri. Gorunum
 * `components/ui/Button` birincil / ikincil varyantlariyla aynidir (o bilesen <button> uretir;
 * sayfa degistiren eylem baglanti olmalidir).
 */
export function ctaClass(variant: 'primary' | 'secondary' = 'primary', size: 'md' | 'lg' = 'md', className?: string) {
  return cn(
    'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    variant === 'primary' ? 'bg-primary text-on-primary shadow-sm hover:bg-primary-hover' : 'border border-border-strong bg-surface-muted/40 text-text hover:bg-surface-muted',
    size === 'lg' ? 'h-12 px-6 text-body' : 'h-10 px-4 text-small',
    className,
  );
}

/** Metin baglantisi (gezinme, alt bilgi). */
export const textLinkClass =
  'rounded-sm text-text-secondary underline-offset-4 hover:text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
