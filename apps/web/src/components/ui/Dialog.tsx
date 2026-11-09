import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { cn } from '@/lib/cn';

type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Baslik ekran okuyucu icin kalsin ama gorunmesin (ornek: menu cekmecesi). */
  hideTitle?: boolean;
  /** modal: ortada kutu. sheet: soldan kayan cekmece (mobil menu). */
  variant?: 'modal' | 'sheet';
  children: ReactNode;
  className?: string;
};

const variants = {
  modal: 'm-auto w-[calc(100%-2rem)] max-w-md rounded-lg starting:open:scale-95 starting:open:opacity-0',
  sheet: 'my-0 mr-auto ml-0 h-dvh max-h-dvh w-72 max-w-[85vw] starting:open:-translate-x-full',
} as const;

/**
 * Yerel <dialog> + showModal(): odak hapsi, Escape ile kapanma, arka planin `inert`
 * olmasi ve ust katman (top layer) tarayicidan gelir; ek kutuphane gerekmez.
 */
export function Dialog({ open, onClose, title, hideTitle, variant = 'modal', children, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      // Arka plana (backdrop) tiklama: hedef dialog'un kendisi olur.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className={cn(
        'border border-border bg-surface p-0 text-text shadow-xl backdrop:bg-scrim',
        'transition duration-200 ease-out motion-reduce:transition-none',
        variants[variant],
        className,
      )}
    >
      <div className="flex h-full flex-col">
        <div className={cn('flex items-center justify-between gap-4 px-5 pt-4', hideTitle && 'justify-end')}>
          <h2 id={titleId} className={cn('text-heading font-semibold', hideTitle && 'sr-only')}>
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Kapat"
            className="grid size-9 place-items-center rounded-md text-muted hover:bg-surface-muted hover:text-text"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-5">{children}</div>
      </div>
    </dialog>
  );
}
