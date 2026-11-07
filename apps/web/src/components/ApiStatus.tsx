import { Button } from '@/components/ui';
import { useApiHealth } from '@/hooks/useApiHealth';
import { cn } from '@/lib/cn';

const shortVersion = (version: string) => (/^[0-9a-f]{40}$/.test(version) ? version.slice(0, 7) : version);

export function ApiStatus() {
  const { data, isPending, isError, refetch, isFetching } = useApiHealth();
  const state = isPending ? 'loading' : isError ? 'error' : 'ok';

  return (
    <div className="flex flex-wrap items-center gap-3">
      <p role="status" className="m-0 flex items-center gap-2 text-small text-muted">
        <span
          aria-hidden="true"
          className={cn(
            'size-2 shrink-0 rounded-full bg-muted',
            state === 'ok' && 'bg-success',
            state === 'error' && 'bg-danger',
          )}
        />
        {state === 'loading' && 'API durumu kontrol ediliyor…'}
        {state === 'ok' && data && (
          <span>
            API çalışıyor · sürüm <code>{shortVersion(data.version)}</code>
          </span>
        )}
        {state === 'error' && 'API durumu: ulaşılamıyor'}
      </p>
      {state === 'error' && (
        <Button size="sm" variant="secondary" loading={isFetching} onClick={() => void refetch()}>
          Tekrar dene
        </Button>
      )}
    </div>
  );
}
