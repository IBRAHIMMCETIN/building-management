import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

const tones = {
  info: { icon: Info, className: 'border-border-strong bg-surface-muted/40 text-text-secondary' },
  success: { icon: CircleCheck, className: 'border-success/20 bg-success/10 text-success' },
  danger: { icon: CircleAlert, className: 'border-danger/20 bg-danger/10 text-danger' },
} as const;

export function Alert({ tone = 'info', children }: { tone?: keyof typeof tones; children: ReactNode }) {
  const { icon: Icon, className } = tones[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex items-start gap-2 rounded-lg border px-3 py-2.5 text-small', className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}
