/** Yatay ilerleme cubugu (erisilebilir: role=progressbar). */
export function ImportProgress({ percent, label }: { percent: number; label: string }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-label="Aktarım ilerlemesi"
        className="h-2.5 w-full overflow-hidden rounded-full bg-surface-muted"
      >
        <div className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out" style={{ width: `${value}%` }} />
      </div>
      <p className="flex justify-between text-small text-muted tabular-nums">
        <span>{label}</span>
        <span>%{value}</span>
      </p>
    </div>
  );
}
