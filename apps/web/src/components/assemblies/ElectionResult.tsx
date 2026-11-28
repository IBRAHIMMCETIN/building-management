import { Badge } from '@/components/ui';
import type { Election, PortalDecision } from '@/lib/api/assemblies';
import { formatBps } from '@/lib/api/pollModel';

type PortalElection = NonNullable<PortalDecision['election']>;

/** Yonetim (tam sonuc) veya sakin portali (toplamlar) secim sonucu. */
export type ElectionView = Pick<Election, 'candidates'> & { winnerCandidateId?: string | null; noWinner?: string; warnings?: string[] } | PortalElection;

const winnerOf = (e: ElectionView) => ('winnerName' in e ? e.winnerName : (e.candidates.find((c) => c.candidateId === e.winnerCandidateId)?.name ?? null));

/**
 * Cok adayli secim sonucu (KMK m.34 yonetici / m.41 denetci): aday basina oy (m.31 sinirli), kat
 * maliki, bolum ve arsa payi; secilen aday veya "Secim yapilamadi" aciklamasi.
 */
export function ElectionResult({ election: e }: { election: ElectionView }) {
  const winner = winnerOf(e);
  const warnings = 'warnings' in e ? (e.warnings ?? []) : [];
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <p className="text-small font-medium">{winner ? `Seçilen: ${winner}` : 'Seçim yapılamadı'}</p>
      {!winner && e.noWinner && <p className="text-muted">{e.noWinner}</p>}
      <ul className="flex flex-col gap-1 text-muted tabular-nums">
        {e.candidates.map((c) => (
          <li key={c.candidateId} className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-text">{c.name}</span>
            {c.elected && <Badge tone="success">Seçildi</Badge>}
            <span>
              {c.votes} oy · {c.persons} kat maliki · {c.units} bölüm{c.landShareBps !== null ? ` · arsa payı ${formatBps(c.landShareBps)}` : ''}
            </span>
          </li>
        ))}
      </ul>
      {warnings.map((w) => (
        <p key={w} className="text-muted">
          {w}
        </p>
      ))}
    </div>
  );
}
