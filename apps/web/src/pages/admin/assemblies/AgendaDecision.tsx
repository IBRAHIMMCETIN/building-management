import { type ReactNode, useMemo, useState } from 'react';
import { ElectionResult } from '@/components/assemblies/ElectionResult';
import { Alert, Badge, Button, Card, FormField, Input, Select, Textarea } from '@/components/ui';
import { useRecordTally } from '@/hooks/useAssemblies';
import {
  ABSTAIN,
  type AgendaItem,
  type Assembly,
  type AssemblyUnit,
  CHOICE_LABELS,
  DECISION_LABELS,
  DECISION_PRESETS,
  type Decision,
  type DecisionOutcome,
  MAJORITY_LABELS,
  PERSON_RULES,
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
import { ballotsInput, needsUnitVotes, prefillUnitVotes, setUnitVote, tallyIssue, unitVotesInput } from './schemas';

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

/** Oy / kisi / bolum / arsa payi ozeti. */
function outcomeLine(o: DecisionOutcome, k: VoteChoice) {
  const parts = [`${o.votes[k]} oy`];
  if (o.persons) parts.push(`${o.persons[k]} kat maliki`);
  if (o.units) parts.push(`${o.units[k]} bölüm`);
  if (o.landShare && o.landShareBps) parts.push(`arsa payı ${formatFraction(o.landShare[k])} (${formatBps(o.landShareBps[k])})`);
  return `${CHOICE_LABELS[k]}: ${parts.join(' · ')}`;
}

/** Duzeltme girisi iptal kutusu gibi kart icinde (CancelBox); ilk karar girisi satirin icinde. */
function EntryBox({ boxed, children }: { boxed: boolean; children: ReactNode }) {
  return boxed ? <Card className="flex flex-col gap-3">{children}</Card> : <div className="flex flex-col gap-3">{children}</div>;
}

/** Gundem maddesi: karar turu, gerekli cogunluk, kayitli karar ve duzeltmeleri, karar / duzeltme girisi. */
export function AgendaDecision({ index, item, assembly, quorum, units, records, canTally, canCorrect, unitLabel }: Props) {
  const record = useRecordTally(assembly.assemblyId);
  const rule = itemRule(item);
  const kind = itemKind(item);
  const candidates = item.candidates ?? [];
  const election = candidates.length > 0;
  const byUnit = needsUnitVotes(rule) && !election;
  const latest = records.at(-1);
  const decided = Boolean(item.tally);
  const [editing, setEditing] = useState(false);
  const [counts, setCounts] = useState({ yes: '', no: '', abstain: '' });
  const [votes, setVotes] = useState<Record<string, VoteChoice | ''>>({});
  /** Secim maddesi: bolum -> aday kimligi / `abstain` / '' (oy kullanmadi). */
  const [ballots, setBallots] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [issue, setIssue] = useState<string | null>(null);
  const present = useMemo(() => units.filter((u) => u.attendance && u.attendance.mode !== 'absent'), [units]);
  const open = decided ? editing && canCorrect : canTally;
  const preset = kind === 'custom' ? undefined : DECISION_PRESETS[kind];

  /** Duzeltme kayitli oylarla on doldurulur (yalnizca degisen girilir). */
  const startCorrection = () => {
    const t = item.tally;
    if (t) setCounts({ yes: String(t.yes), no: String(t.no), abstain: String(t.abstain) });
    setVotes(prefillUnitVotes(latest?.unitVotes));
    setBallots({ ...(latest?.unitBallots ?? {}) });
    setEditing(true);
  };

  const save = async () => {
    let body: { yes: number; no: number; abstain: number } | { votes: Record<string, VoteChoice> } | { ballots: Record<string, string> };
    if (election) {
      body = { ballots: ballotsInput(ballots) };
    } else if (byUnit) {
      body = { votes: unitVotesInput(votes) };
    } else {
      const parsed = { yes: Number(counts.yes || 0), no: Number(counts.no || 0), abstain: Number(counts.abstain || 0) };
      const problem = tallyIssue(parsed, quorum.presentVotes);
      setIssue(problem);
      if (problem) return;
      body = parsed;
    }
    if (decided && reason.trim().length < 3) return;
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
        {item.decisionKind ? kindLabel(kind) : 'Karar türü kaydı yok (Y1 sayımı)'} · Gerekli: {MAJORITY_LABELS[rule]}
        {preset ? ` (${preset.legal})` : ''}
      </p>
      {preset?.hint && <p className="text-xs text-muted">{preset.hint}</p>}

      {election && !latest && <p className="text-xs text-muted">Adaylar: {candidates.map((c) => c.name).join(', ')}</p>}

      {latest?.election ? (
        <div className="flex flex-col gap-1">
          <ElectionResult election={latest.election} />
          <span className="text-xs text-muted">
            Kayıt: {formatDateTime(latest.recordedAt)}
            {latest.correctionReason ? ` · düzeltme (gerekçe: ${latest.correctionReason})` : ''}
            {records.length > 1 ? ` · önceki ${records.length - 1} kayıt silinmez` : ''}
          </span>
        </div>
      ) : latest ? (
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
            {latest.correctionReason ? ` · düzeltme (gerekçe: ${latest.correctionReason})` : ''}
          </span>
          {records[0]?.legacyTally && (
            <span>
              Düzeltilen Y1 sayımı: kabul {records[0].legacyTally.yes} · ret {records[0].legacyTally.no} · çekimser {records[0].legacyTally.abstain} ({formatDateTime(records[0].legacyTally.recordedAt)})
            </span>
          )}
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
          <Button size="xs" variant="subtle" onClick={startCorrection}>
            Kararı düzelt
          </Button>
        </div>
      )}

      {open && (
        <EntryBox boxed={decided}>
          {decided && <p className="text-small text-muted">Kayıtlı karar değişmez: düzeltme gerekçesiyle yeni kayıt olarak eklenir ve tutanakta / karar defterinde birlikte görünür.</p>}
          {election ? (
            <div className="flex flex-col gap-2">
              <p className="text-small text-muted">
                Her oy veren tek aday seçer veya çekimser kalır; aynı kişinin oyunu kullandığı ve aynı kat malikine düşen bölümler birlikte işaretlenir. Aday bütün kat maliklerinin sayı ve arsa payı
                çoğunluğuna ulaşırsa seçilir; en çok oy alan kendiliğinden seçilmez.
              </p>
              {present.length === 0 ? (
                <p className="text-small">Katılım girilmedi.</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full text-left text-small">
                    <caption className="sr-only">{index + 1}. madde bölüm bazında aday oyu</caption>
                    <thead className="border-b border-border bg-surface-muted/50 text-xs text-muted">
                      <tr>
                        <th scope="col" className="px-3 py-2 font-medium">
                          Bölüm
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          Arsa payı
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          Aday
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {present.map((u) => (
                        <tr key={u.unitId}>
                          <td className="px-3 py-2">{unitLabel(u)}</td>
                          <td className="px-3 py-2 tabular-nums">{u.landShare ? formatFraction(u.landShare) : '—'}</td>
                          <td className="px-3 py-2">
                            <Select aria-label={`${unitLabel(u)} aday oyu`} value={ballots[u.unitId] ?? ''} onChange={(e) => setBallots(setUnitVote<string>(ballots, present, u.unitId, e.target.value, rule))}>
                              <option value="">Oy kullanmadı</option>
                              {candidates.map((c) => (
                                <option key={c.candidateId} value={c.candidateId}>
                                  {c.name}
                                </option>
                              ))}
                              <option value={ABSTAIN}>{CHOICE_LABELS.abstain}</option>
                            </Select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : byUnit ? (
            <div className="flex flex-col gap-2">
              <p className="text-small text-muted">
                Payda bütün kat malikleridir ({quorum.totalUnits} bölüm); katılmayan bölüm kabul sayılmaz. Aynı kişinin oyunu kullandığı bölümler{PERSON_RULES.includes(rule) ? ' ve aynı kat malikine düşen bölümler (kişi sayımı)' : ''} birlikte işaretlenir.
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
                              onChange={(e) => setVotes(setUnitVote(votes, present, u.unitId, e.target.value as VoteChoice | '', rule))}
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
          {decided ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" disabled={record.isPending} onClick={() => setEditing(false)}>
                Vazgeç
              </Button>
              <Button loading={record.isPending} disabled={reason.trim().length < 3} onClick={() => void save()}>
                Düzeltmeyi kaydet
              </Button>
            </div>
          ) : (
            <div>
              <Button size="sm" loading={record.isPending} onClick={() => void save()}>
                Kararı kaydet
              </Button>
            </div>
          )}
        </EntryBox>
      )}
      {issue && <Alert tone="danger">{issue}</Alert>}
      {record.isError && <Alert tone="danger">{errorMessage(record.error)}</Alert>}
    </div>
  );
}
