import { useMemo, useState } from 'react';
import { Alert, Badge, Button, FormField, Input, Select, Textarea } from '@/components/ui';
import { useRecordTally } from '@/hooks/useAssemblies';
import {
  type AgendaItem,
  type Assembly,
  type AssemblyUnit,
  CHOICE_LABELS,
  DECISION_LABELS,
  DECISION_PRESETS,
  type Decision,
  type DecisionOutcome,
  MAJORITY_LABELS,
  type Quorum,
  VOTE_CHOICES,
  type VoteChoice,
  itemKind,
  itemRule,
  kindLabel,
  requiredText,
} from '@/lib/api/assemblies';
import { errorMessage } from '@/lib/api/errors';
import { formatBps, formatFraction } from '@/lib/api/pollModel';
import { formatDateTime } from '@/lib/dates';
import { needsUnitVotes, setUnitVote, tallyIssue, unitVotesInput } from './schemas';

type Props = {
  index: number;
  item: AgendaItem;
  assembly: Assembly;
  quorum: Quorum;
  units: AssemblyUnit[];
  /** Bu maddenin karar kayitlari (sira artan). */
  records: Decision[];
  /** Yeni karar girilebilir mi (toplanti planli, basladi, yeter sayi var). */
  canTally: boolean;
  /** Kayitli karar duzeltilebilir mi (yazma yetkisi, toplanti iptal degil). */
  canCorrect: boolean;
  unitLabel: (u: AssemblyUnit) => string;
};

/** Oy / bolum / arsa payi ozeti. */
function outcomeLine(o: DecisionOutcome, k: VoteChoice) {
  const parts = [`${o.votes[k]} oy`];
  if (o.units) parts.push(`${o.units[k]} bölüm`);
  if (o.landShare && o.landShareBps) parts.push(`arsa payı ${formatFraction(o.landShare[k])} (${formatBps(o.landShareBps[k])})`);
  return `${CHOICE_LABELS[k]}: ${parts.join(' · ')}`;
}

/** Gundem maddesi: karar turu, gerekli cogunluk, kayitli karar ve duzeltmeleri, karar / duzeltme girisi. */
export function AgendaDecision({ index, item, assembly, quorum, units, records, canTally, canCorrect, unitLabel }: Props) {
  const record = useRecordTally(assembly.assemblyId);
  const rule = itemRule(item);
  const kind = itemKind(item);
  const byUnit = needsUnitVotes(rule);
  const latest = records.at(-1);
  const decided = Boolean(item.tally);
  const [editing, setEditing] = useState(false);
  const [counts, setCounts] = useState({ yes: '', no: '', abstain: '' });
  const [votes, setVotes] = useState<Record<string, VoteChoice | ''>>({});
  const [reason, setReason] = useState('');
  const [issue, setIssue] = useState<string | null>(null);
  const present = useMemo(() => units.filter((u) => u.attendance && u.attendance.mode !== 'absent'), [units]);
  const open = decided ? editing && canCorrect : canTally;

  const save = async () => {
    let body: { yes: number; no: number; abstain: number } | { votes: Record<string, VoteChoice> };
    if (byUnit) {
      body = { votes: unitVotesInput(votes) };
    } else {
      const parsed = { yes: Number(counts.yes || 0), no: Number(counts.no || 0), abstain: Number(counts.abstain || 0) };
      const problem = tallyIssue(parsed, quorum.presentVotes);
      setIssue(problem);
      if (problem) return;
      body = parsed;
    }
    if (decided && reason.trim().length < 3) {
      setIssue('Düzeltme gerekçesi en az 3 karakter olmalı');
      return;
    }
    setIssue(null);
    try {
      await record.mutateAsync({ itemId: item.itemId, input: { version: assembly.version, ...body, ...(decided ? { correctionReason: reason.trim() } : {}) } });
      setEditing(false);
      setReason('');
    } catch {
      // Hata satirda gosterilir.
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-medium break-words">
          {index + 1}. {item.title}
        </p>
        {item.tally && <Badge tone={item.tally.decision === 'accepted' ? 'success' : 'danger'}>{DECISION_LABELS[item.tally.decision]}</Badge>}
      </div>
      {item.description && <p className="text-small text-muted">{item.description}</p>}
      <p className="text-xs text-muted">
        {kindLabel(kind)} · Gerekli: {MAJORITY_LABELS[rule]}
        {kind !== 'custom' ? ` (${DECISION_PRESETS[kind].legal})` : ''}
      </p>

      {latest ? (
        <div className="flex flex-col gap-1 text-xs text-muted tabular-nums">
          {VOTE_CHOICES.map((k) => (
            <span key={k}>{outcomeLine(latest.outcome, k)}</span>
          ))}
          <span>Gerekli: {requiredText(latest.outcome)}</span>
          {latest.outcome.reasons.map((r) => (
            <span key={r} className="text-danger">
              {r}
            </span>
          ))}
          {latest.outcome.warnings.map((w) => (
            <span key={w}>{w}</span>
          ))}
          <span>
            Kayıt: {formatDateTime(latest.recordedAt)}
            {latest.supersedes ? ` · düzeltme (gerekçe: ${latest.correctionReason ?? ''})` : ''}
          </span>
          {records.length > 1 && (
            <span>
              Önceki kayıtlar silinmez: {records.slice(0, -1).map((r) => `${formatDateTime(r.recordedAt)} ${DECISION_LABELS[r.outcome.decision].toLocaleLowerCase('tr')} (kabul ${r.outcome.votes.yes})`).join(' · ')}
            </span>
          )}
        </div>
      ) : (
        item.tally && (
          <p className="text-xs text-muted tabular-nums">
            Kabul {item.tally.yes} · Ret {item.tally.no} · Çekimser {item.tally.abstain} · Katılan {item.tally.presentVotes} oy · {formatDateTime(item.tally.recordedAt)}
          </p>
        )
      )}

      {decided && canCorrect && !editing && (
        <div>
          <Button size="xs" variant="subtle" onClick={() => setEditing(true)}>
            Kararı düzelt
          </Button>
        </div>
      )}

      {open && (
        <div className="flex flex-col gap-3">
          {decided && <p className="text-small text-muted">Kayıtlı karar değişmez: düzeltme gerekçesiyle yeni kayıt olarak eklenir ve tutanakta / karar defterinde birlikte görünür.</p>}
          {byUnit ? (
            <div className="flex flex-col gap-2">
              <p className="text-small text-muted">
                Payda bütün kat malikleridir ({quorum.totalUnits} bölüm); katılmayan bölüm kabul sayılmaz. Aynı kişinin oyunu kullandığı bölümler birlikte işaretlenir.
              </p>
              {present.length === 0 ? (
                <p className="text-small">Katılım girilmedi.</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full text-left text-small">
                    <caption className="sr-only">{index + 1}. madde bölüm bazında oy</caption>
                    <thead className="border-b border-border bg-surface-muted/50 text-xs text-muted">
                      <tr>
                        <th scope="col" className="px-3 py-2 font-medium">
                          Bölüm
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          Arsa payı
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          Oy
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {present.map((u) => (
                        <tr key={u.unitId}>
                          <td className="px-3 py-2">{unitLabel(u)}</td>
                          <td className="px-3 py-2 tabular-nums">{u.landShare ? formatFraction(u.landShare) : '—'}</td>
                          <td className="px-3 py-2">
                            <Select
                              aria-label={`${unitLabel(u)} oyu`}
                              value={votes[u.unitId] ?? ''}
                              onChange={(e) => setVotes(setUnitVote(votes, present, u.unitId, e.target.value as VoteChoice | ''))}
                            >
                              <option value="">Oy kullanmadı</option>
                              {VOTE_CHOICES.map((c) => (
                                <option key={c} value={c}>
                                  {CHOICE_LABELS[c]}
                                </option>
                              ))}
                            </Select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              {(['yes', 'no', 'abstain'] as const).map((k) => (
                <div key={k} className="w-24">
                  <FormField label={CHOICE_LABELS[k]}>
                    <Input type="number" inputMode="numeric" min={0} max={quorum.presentVotes} value={counts[k]} onChange={(e) => setCounts({ ...counts, [k]: e.target.value })} />
                  </FormField>
                </div>
              ))}
            </div>
          )}
          {decided && (
            <FormField label="Düzeltme gerekçesi" hint="Gerekçe denetim günlüğüne ve tutanağa yazılır.">
              <Textarea maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </FormField>
          )}
          <div className="flex flex-wrap gap-2">
            {decided && (
              <Button size="sm" variant="ghost" disabled={record.isPending} onClick={() => setEditing(false)}>
                Vazgeç
              </Button>
            )}
            <Button size="sm" loading={record.isPending} onClick={() => void save()}>
              {decided ? 'Düzeltmeyi kaydet' : 'Kararı kaydet'}
            </Button>
          </div>
        </div>
      )}
      {(issue || record.isError) && <Alert tone="danger">{issue ?? errorMessage(record.error)}</Alert>}
    </div>
  );
}
