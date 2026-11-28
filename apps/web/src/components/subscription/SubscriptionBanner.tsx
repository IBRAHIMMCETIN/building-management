import { CircleAlert, Clock, Lock } from 'lucide-react';
import { Link } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { useSubscriptionStatus } from '@/hooks/useSubscriptions';
import { cn } from '@/lib/cn';
import { type BannerState, bannerFor } from '@/lib/subscriptions/model';
import { OFFICE_ROLES, type Role } from '@/types/roles';

const TONES: Record<BannerState['tone'], { box: string; icon: string; Icon: typeof Clock }> = {
  neutral: { box: 'border-border bg-surface-muted', icon: 'text-accent', Icon: Clock },
  warning: { box: 'border-warning/30 bg-warning/15', icon: 'text-warning', Icon: CircleAlert },
  danger: { box: 'border-danger/30 bg-danger/10', icon: 'text-danger', Icon: Lock },
};

/**
 * Abonelik ust bandi (yonetim paneli, her ekranin ustunde): denemenin son 7 gunu, geciken odeme ve
 * salt okunur (askida / sona ermis) durum. Abonelik oncesi (legacy) ve olagan durumda gorunmez.
 * "Aboneligi goruntule" yalnizca Ayarlar'i gorebilen rollere.
 */
export function SubscriptionBanner() {
  const { user } = useAuth();
  const status = useSubscriptionStatus();
  const state = bannerFor(status.data);
  if (!state) return null;
  const tone = TONES[state.tone];
  const canOpen = !!user?.role && (OFFICE_ROLES as readonly Role[]).includes(user.role);

  return (
    <div role="status" className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5 text-small md:px-8', tone.box)}>
      <tone.Icon className={cn('size-4 shrink-0', tone.icon)} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <strong>{state.title}</strong> {state.text}
      </span>
      {canOpen && (
        <Link to="/admin/settings" className="font-medium text-accent underline-offset-2 hover:underline">
          Aboneliği görüntüle
        </Link>
      )}
    </div>
  );
}
