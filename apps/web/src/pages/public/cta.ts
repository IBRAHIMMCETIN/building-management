import { cn } from '@/lib/cn';

/**
 * Buton gibi gorunen baglanti (<a>): tanitim ve hukuki sayfalarda gezinme eylemleri. Gorunum
 * `components/ui/Button` birincil / ikincil varyantlariyla aynidir (o bilesen <button> uretir;
 * sayfa degistiren eylem baglanti olmalidir). `inverse`: vurgu bandi (bg-band) uzerindeki birincil
 * eylem; zemin ve yazi rengi yer degistirir, odak cizgisi bant uzerinde gorunsun diye on-band renginde.
 */
const VARIANTS = {
  primary: 'bg-primary text-on-primary shadow-sm hover:bg-primary-hover',
  secondary: 'border border-border-strong bg-surface-muted/40 text-text hover:bg-surface-muted',
  inverse: 'bg-on-band text-band shadow-sm hover:bg-on-band/90 focus-visible:outline-on-band',
} as const;

export function ctaClass(variant: keyof typeof VARIANTS = 'primary', size: 'md' | 'lg' = 'md', className?: string) {
  return cn(
    'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    VARIANTS[variant],
    size === 'lg' ? 'h-12 px-6 text-body' : 'h-10 px-4 text-small',
    className,
  );
}

/** Metin baglantisi (gezinme, alt bilgi). */
export const textLinkClass =
  'rounded-sm text-text-secondary underline-offset-4 hover:text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
