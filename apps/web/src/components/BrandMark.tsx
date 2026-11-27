import { BRAND_NAME, BRAND_PARTS, BRAND_TAGLINE } from '@/lib/brand';
import { cn } from '@/lib/cn';

type MarkProps = { className?: string; /** Yanında marka adı yazıyorsa simge dekoratiftir. */ decorative?: boolean };

/**
 * Logo simgesi (bina). Koyu temada lacivert kısımları açık renkli sürüm gösterilir
 * (public/brand/mark-dark.png). Boyut `className` ile verilir (ör. size-6).
 */
export function BrandMark({ className, decorative = true }: MarkProps) {
  return (
    <picture className={cn('inline-block shrink-0', className)}>
      <source srcSet="/brand/mark-dark.png" media="(prefers-color-scheme: dark)" />
      <img src="/brand/mark.png" alt={decorative ? '' : BRAND_NAME} className="size-full object-contain" draggable={false} />
    </picture>
  );
}

/** Kelime marka: logodaki gibi "YÖNE" + turuncu "SİST", isteğe bağlı alt satırla. */
export function BrandWordmark({ tagline = false, className }: { tagline?: boolean; className?: string }) {
  return (
    <span className={cn('flex flex-col items-center leading-tight', className)}>
      <span className="font-extrabold tracking-wide text-brand-ink">
        {BRAND_PARTS[0]}
        <span className="text-brand-orange">{BRAND_PARTS[1]}</span>
      </span>
      {tagline && <span className="text-small font-medium tracking-wide text-muted uppercase">{BRAND_TAGLINE}</span>}
    </span>
  );
}
