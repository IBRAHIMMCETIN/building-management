/* Guvenlik kapisi ortak gosterim parcalari (yonetim, gorevli ve sakin ekranlari). */
import { LogIn, LogOut } from 'lucide-react';
import { Badge } from '@/components/ui';
import type { Courier, GateLogEntry } from '@/lib/api/gate';
import { formatDateTime } from '@/lib/dates';
import { COURIER_TEXT, DIRECTION_TEXT, LOG_KIND_TEXT, type PassVerdict, VERDICT_TEXT, courierState } from '@/lib/gate/plate';

export function VerdictBadge({ verdict }: { verdict: PassVerdict }) {
  const v = VERDICT_TEXT[verdict];
  return <Badge tone={v.tone}>{v.label}</Badge>;
}

export function CourierBadge({ courier }: { courier: Pick<Courier, 'status' | 'expired' | 'approvalExpired' | 'enteredAt' | 'exitedAt'> }) {
  const c = COURIER_TEXT[courierState(courier)];
  return <Badge tone={c.tone}>{c.label}</Badge>;
}

/** Saat:dakika (Istanbul). */
export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' });

/** Kapi gunlugu satiri (yonetim / gorevli / sakin ortak). */
export function LogRow({ e }: { e: GateLogEntry }) {
  const Icon = e.direction === 'entry' ? LogIn : LogOut;
  const who = e.visitorName ?? e.company ?? LOG_KIND_TEXT[e.kind];
  return (
    <li className="flex items-start gap-3 rounded-xl border border-border bg-surface p-3 shadow-xs">
      <Icon className={e.direction === 'entry' ? 'mt-0.5 size-5 text-success' : 'mt-0.5 size-5 text-muted'} aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{who}</span>
          <Badge tone={e.direction === 'entry' ? 'success' : 'neutral'}>{DIRECTION_TEXT[e.direction]}</Badge>
          <span className="text-xs text-muted">{LOG_KIND_TEXT[e.kind]}</span>
        </span>
        <span className="text-small text-text-secondary">
          {e.unitLabel ?? 'Bağımsız bölüm yok'}
          {e.plateDisplay && <span className="font-mono"> · {e.plateDisplay}</span>}
          {e.kind === 'courier' && e.company && e.visitorName ? ` · ${e.company}` : ''}
        </span>
        {e.note && <span className="text-small text-muted">{e.note}</span>}
        <span className="text-xs text-muted">
          {formatDateTime(e.at)}
          {e.recordedByName && ` · ${e.recordedByName}`}
        </span>
      </span>
    </li>
  );
}
