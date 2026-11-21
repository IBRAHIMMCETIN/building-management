import { LifeBuoy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { useEndSupport } from '@/hooks/useSecurity';
import { PLATFORM_HOME } from '@/types/roles';

/** Kalan sure: "12:05" (dakika:saniye); dolmussa "00:00". */
export function formatRemaining(expiresAt: string, now: number): string {
  const left = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  return `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
}

/**
 * Destek modunda her ekranin ustunde: hangi apartmanda, salt okunur, kalan sure ve cikis.
 * Sure dolunca mod kapanir ve platform paneline donulur (API de oturumu reddeder).
 */
export function SupportBanner() {
  const { support, leaveSupport } = useAuth();
  const end = useEndSupport();
  const navigate = useNavigate();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!support) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [support]);

  useEffect(() => {
    if (support && Date.parse(support.expiresAt) <= now) {
      leaveSupport();
      navigate(PLATFORM_HOME, { replace: true });
    }
  }, [support, now, leaveSupport, navigate]);

  if (!support) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning/30 bg-warning/15 px-4 py-2 text-small md:px-8"
    >
      <LifeBuoy className="size-4 shrink-0 text-warning" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <strong>Destek oturumu:</strong> {support.apartmentName ?? support.apartmentId} · salt okunur · her işlem apartmanın
        denetim günlüğüne yazılıyor · kalan <span className="font-mono tabular-nums">{formatRemaining(support.expiresAt, now)}</span>
      </span>
      <Button
        size="sm"
        variant="secondary"
        loading={end.isPending}
        onClick={() =>
          end.mutate(undefined, {
            onSettled: () => navigate(PLATFORM_HOME, { replace: true }),
          })
        }
      >
        Oturumu bitir
      </Button>
    </div>
  );
}
