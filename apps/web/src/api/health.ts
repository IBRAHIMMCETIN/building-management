export type Health = {
  status: 'ok';
  version: string;
  startedAt: string;
  time: string;
};

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  const res = await fetch('/api/health', { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET /api/health ${res.status}`);
  return (await res.json()) as Health;
}
