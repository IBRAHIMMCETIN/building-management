import { ChevronRight, Landmark } from 'lucide-react';
import { Link } from 'react-router';
import { Badge, Card, Skeleton } from '@/components/ui';
import { useMyAssemblies } from '@/hooks/useAssemblies';
import { KIND_LABELS, PORTAL_PHASE_LABELS, PORTAL_PHASE_TONES, type PortalAssembly } from '@/lib/api/assemblies';
import { formatDateTime } from '@/lib/dates';
import { AssemblyQueryState } from './AssemblyQueryState';

/** Sakin "Genel Kurul" (yalnizca kat maliki): yaklasan toplantilar once, sonra gecmis toplantilar. */
export function MyAssembliesPage() {
  const list = useMyAssemblies();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title font-bold">Genel Kurul</h1>

      {list.isPending ? (
        <div role="status" aria-label="Toplantılar yükleniyor" className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <Card key={i} className="flex flex-col gap-3">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-4 w-1/3" />
            </Card>
          ))}
        </div>
      ) : list.isError ? (
        <AssemblyQueryState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-surface-muted text-accent">
            <Landmark className="size-6" aria-hidden="true" />
          </div>
          <p className="font-semibold">Henüz toplantı yok</p>
          <p className="text-small text-muted">Yönetiminiz bir kat malikleri kurulu toplantısına çağrı yaptığında burada görünecek.</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.data.map((a) => (
            <li key={a.assemblyId}>
              <AssemblyLink assembly={a} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AssemblyLink({ assembly: a }: { assembly: PortalAssembly }) {
  return (
    <Link
      to={`/app/genel-kurul/${encodeURIComponent(a.assemblyId)}`}
      className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4 shadow-xs hover:border-border-strong"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-medium break-words">
          {KIND_LABELS[a.kind]}
          {a.secondMeeting ? ' (ikinci toplantı)' : ''}
        </span>
        <span className="text-xs break-words text-muted">
          {formatDateTime(a.scheduledAt)} · {a.location ?? 'Çevrim içi'} · {a.agenda.length} gündem maddesi
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={PORTAL_PHASE_TONES[a.phase]}>{PORTAL_PHASE_LABELS[a.phase]}</Badge>
          {a.minutesAvailable && <span className="text-xs text-muted">Tutanak hazır</span>}
        </span>
      </span>
      <ChevronRight className="size-5 text-muted" aria-hidden="true" />
    </Link>
  );
}
