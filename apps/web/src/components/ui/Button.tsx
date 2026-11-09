import { LoaderCircle } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const variants = {
  /** Sayfanin ana aksiyonu: dolu, canli. */
  primary: 'bg-primary text-on-primary shadow-sm hover:bg-primary-hover',
  /** Ikincil aksiyon: gorunur kenarlikli. */
  secondary: 'border border-border-strong bg-surface-muted/40 text-text hover:bg-surface-muted',
  ghost: 'text-muted hover:bg-surface-muted hover:text-text',
  /** Kart ici kucuk aksiyonlar (Duzenle, Arsivle...): ikonlu, sessiz. */
  subtle: 'text-muted hover:bg-surface-muted hover:text-text',
  danger: 'bg-danger text-white shadow-sm hover:opacity-90',
} as const;

const sizes = {
  xs: 'h-7 gap-1.5 px-2.5 text-xs',
  sm: 'h-8 px-3 text-small',
  md: 'h-10 px-4 text-small',
} as const;

export type ButtonProps = ComponentProps<'button'> & {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  loading?: boolean;
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
