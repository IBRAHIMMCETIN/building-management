import { ArrowLeftRight } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Dialog } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { useContexts, useSwitchContext } from '@/hooks/useContexts';
import { errorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { ContextList } from './ContextList';

/**
 * Birden fazla secenek varsa true. platform_admin baglami Cognito group'undan geldigi
 * icin apartman secimi ona etki etmez; o zaman da false.
 */
export function useCanSwitchContext(): boolean {
  const { data } = useContexts();
  return Boolean(data && !data.isPlatformAdmin && data.contexts.length > 1);
}

/** Apartman/rol secim modali. Ust bar dugmesi ve mobil cekmece ayni bileseni acar. */
export function ContextSwitchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const contexts = useContexts();
  const switcher = useSwitchContext();

  const close = () => {
    if (switcher.isPending) return;
    switcher.reset();
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} title="Apartman / rol seçin">
      <div className="flex flex-col gap-4">
        {switcher.isError && <Alert tone="danger">{errorMessage(switcher.error)}</Alert>}
        <ContextList
          contexts={contexts.data?.contexts ?? []}
          active={user}
          pending={switcher.isPending ? switcher.variables : null}
          disabled={switcher.isPending}
          onSelect={(ctx) => switcher.mutate(ctx, { onSuccess: onClose })}
        />
      </div>
    </Dialog>
  );
}

const LABEL = 'Apartman / Rol Değiştir';

/**
 * Ust bar dugmesi. Her genislikte gorunur ve daralmaz (shrink-0); dar ekranda yalnizca
 * ikon, genis ekranda "Değiştir" metni. Erisilebilir ad her durumda tam etikettir.
 */
export function ContextSwitcher({ className }: { className?: string }) {
  const canSwitch = useCanSwitchContext();
  const [open, setOpen] = useState(false);
  if (!canSwitch) return null;

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={LABEL}
        title={LABEL}
        className={cn('shrink-0 px-2.5 lg:px-3', className)}
      >
        <ArrowLeftRight className="size-4" aria-hidden="true" />
        <span className="hidden lg:inline">Değiştir</span>
      </Button>
      <ContextSwitchDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
