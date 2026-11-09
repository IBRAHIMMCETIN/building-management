import { LoaderCircle } from 'lucide-react';

export function Spinner({ label = 'Yükleniyor…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-muted">
      <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
      <span className="text-small">{label}</span>
    </div>
  );
}

export function FullPageSpinner() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <Spinner />
    </div>
  );
}
