import { useQuery } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, CircleHelp, Filter, Link2, ScrollText, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Dialog, FormField, Input, Select, Skeleton } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { useAuditIntegrity, useAuditLog, useAuditScope, usePageVerification } from '@/hooks/useSecurity';
import { usePeople } from '@/hooks/useUnits';
import { apartmentRolesApi } from '@/lib/api/apartmentRoles';
import type { AuditEntry, AuditFilters, AuditIntegrity } from '@/lib/api/audit';
import { errorMessage } from '@/lib/api/errors';
import { type ActorInfo, actorText, buildActorDirectory } from '@/lib/audit/actor';
import type { EntryCheck, PageCheck } from '@/lib/audit/chain';
import { AUDIT_CATEGORIES, actionLabel, shortHash } from '@/lib/audit/labels';
import { formatDateTime } from '@/lib/dates';

/** "2026-11-21" -> gun basi / sonu (Istanbul, UTC+03:00). */
export function dayRangeToFilters(input: { fromDay: string; toDay: string; action: string; actorId: string }): AuditFilters {
  return {
    ...(input.fromDay ? { from: `${input.fromDay}T00:00:00+03:00` } : {}),
    ...(input.toDay ? { to: `${input.toDay}T23:59:59+03:00` } : {}),
    ...(input.action ? { action: input.action } : {}),
    ...(input.actorId.trim() ? { actorId: input.actorId.trim() } : {}),
  };
}

const INTEGRITY_TEXT: Record<AuditIntegrity['status'], { tone: 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  verified: { tone: 'success', label: 'Zincir doğrulandı' },
  pending: { tone: 'neutral', label: 'Gece doğrulaması bekleniyor' },
  stale: { tone: 'danger', label: 'Doğrulama güncel değil' },
  empty: { tone: 'neutral', label: 'Henüz kayıt yok' },
};

function IntegrityPanel({ integrity, page }: { integrity?: AuditIntegrity; page?: PageCheck }) {
  const s = integrity ? INTEGRITY_TEXT[integrity.status] : undefined;
  return (
    <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        {integrity?.status === 'stale' ? (
          <ShieldQuestion className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
        ) : (
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden="true" />
        )}
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">SHA-256 hash zinciri</span>
            {s && <Badge tone={s.tone}>{s.label}</Badge>}
          </div>
          {integrity && integrity.status !== 'empty' && (
            <p className="text-small text-muted">
              Son kayıt #{integrity.latestSeq}
              {integrity.verifiedAt
                ? ` · gece doğrulaması #${integrity.verifiedSeq} kaydına kadar, ${formatDateTime(integrity.verifiedAt)}`
                : ' · henüz gece doğrulaması yapılmadı'}
            </p>
          )}
          {integrity?.status === 'stale' && (
            <p className="text-small text-danger">
              Son başarılı doğrulama {integrity.staleAfterHours} saatten eski. Gece denetimi çalışmıyor olabilir veya zincirde
              bulgu vardır; platform ekibi alarmı inceliyor.
            </p>
          )}
        </div>
      </div>
      <div className="text-small" aria-live="polite" data-testid="page-check">
        {page ? (
          page.ok ? (
            <span className="inline-flex items-center gap-1 text-success">
              <CircleCheck className="size-4" aria-hidden="true" />
              Görüntülenen {page.checked} kayıt tarayıcıda doğrulandı
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-danger">
              <CircleAlert className="size-4" aria-hidden="true" />
              {page.failures} kayıt doğrulanamadı
            </span>
          )
        ) : null}
      </div>
    </Card>
  );
}

function CheckIcon({ check }: { check?: EntryCheck }) {
  if (!check) return <CircleHelp className="size-4 text-muted" aria-label="Doğrulanmadı" />;
  if (!check.hashOk || check.linkOk === false) return <CircleAlert className="size-4 text-danger" aria-label="Hash uyuşmazlığı" />;
  return <CircleCheck className="size-4 text-success" aria-label="Hash doğrulandı" />;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2 text-small">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function EntryDetail({ entry, check, actor }: { entry: AuditEntry; check?: EntryCheck; actor?: ActorInfo }) {
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col gap-2">
        <Row label="Sıra">#{entry.seq}</Row>
        <Row label="Zaman">{formatDateTime(entry.at)}</Row>
        <Row label="İşlem">
          {actionLabel(entry.action)} <span className="font-mono text-xs text-muted">({entry.action})</span>
        </Row>
        <Row label="Yapan">
          {actorText(entry.actor, actor)}
          {entry.actor.supportSessionId && <Badge tone="warning" className="ml-2">Destek oturumu</Badge>}
          <span className="block font-mono text-xs text-muted">Kullanıcı kimliği: {entry.actor.userId}</span>
        </Row>
        <Row label="Hedef">
          {entry.target.type} · <span className="font-mono text-xs">{entry.target.id}</span>
        </Row>
        {entry.reason && <Row label="Gerekçe">{entry.reason}</Row>}
        {entry.request && (
          <Row label="İstek">
            <span className="font-mono text-xs">
              {entry.request.ip ?? '—'} · {entry.request.userAgent ?? '—'}
            </span>
          </Row>
        )}
      </dl>
      {entry.details && Object.keys(entry.details).length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-small font-medium">Ayrıntılar</span>
          <pre className="max-h-60 overflow-auto rounded-md border border-border bg-surface-muted p-3 text-xs">
            {JSON.stringify(entry.details, null, 2)}
          </pre>
        </div>
      )}
      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <span className="inline-flex items-center gap-2 text-small font-medium">
          <Link2 className="size-4" aria-hidden="true" />
          Zincir
        </span>
        <dl className="flex flex-col gap-1">
          <Row label="Önceki hash">
            <code className="break-all font-mono text-xs">{entry.prevHash}</code>
          </Row>
          <Row label="Hash">
            <code className="break-all font-mono text-xs">{entry.hash}</code>
          </Row>
          <Row label="Tarayıcı">
            {!check
              ? 'Doğrulanmadı'
              : !check.hashOk
                ? 'İçerik hash ile uyuşmuyor'
                : check.linkOk === false
                  ? 'Önceki kayıtla bağ kopuk'
                  : check.linkOk === undefined
                    ? 'Hash doğru (önceki kayıt bu sayfada değil)'
                    : 'Hash ve bağ doğru'}
          </Row>
        </dl>
      </div>
    </div>
  );
}

/**
 * Denetim gunlugu (salt okunur). Apartman rolleri kendi apartmaninin zincirini; platform
 * yoneticisi platform zincirini gorur (apartman zincirine yalnizca destek oturumuyla).
 */
export function AuditPage() {
  const { support, user } = useAuth();
  const scope = useAuditScope();
  const [draft, setDraft] = useState({ fromDay: '', toDay: '', action: '', actorId: '' });
  const [filters, setFilters] = useState<AuditFilters>({});
  const [selected, setSelected] = useState<AuditEntry>();
  const log = useAuditLog(filters);
  const integrity = useAuditIntegrity();
  const people = usePeople();
  // Yonetici / gorevli aktorler sakin dizininde yok: gorev rolleri (gorunen ad) + oturumdaki kullanici.
  const canReadRoles = scope === 'apartment' && !support && (user?.role === 'apartment_manager' || user?.role === 'management_company' || user?.role === 'observer');
  const roles = useQuery({
    queryKey: ['apartment-roles', 'current', user?.apartmentId],
    queryFn: ({ signal }) => apartmentRolesApi.listCurrent(signal).then((r) => r.items),
    enabled: !!user?.apartmentId && canReadRoles,
    retry: false,
    staleTime: 5 * 60_000,
  });

  const entries = useMemo(() => log.data?.pages.flatMap((p) => p.items) ?? [], [log.data]);
  const page = usePageVerification(entries);
  const directory = useMemo(
    () => buildActorDirectory({ people: people.data, roles: roles.data, ...(user?.sub ? { self: { userId: user.sub, email: user.email } } : {}) }),
    [people.data, roles.data, user?.sub, user?.email],
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFilters(dayRangeToFilters(draft));
  };
  const reset = () => {
    setDraft({ fromDay: '', toDay: '', action: '', actorId: '' });
    setFilters({});
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-title font-bold">Denetim Günlüğü</h1>
        <p className="text-small text-muted">
          {scope === 'platform'
            ? 'Platform zinciri: iki adımlı doğrulama, platform yöneticisi sıfırlamaları ve kullanıcı tercihleri. Apartman günlüklerine yalnızca gerekçeli destek oturumuyla erişilir.'
            : 'Hassas işlemlerin değiştirilemez kaydı. Her kayıt bir öncekinin SHA-256 özetine bağlıdır; kayıtlar silinemez ve değiştirilemez.'}
          {support && ' Destek oturumunda salt okunur görüntülüyorsunuz.'}
        </p>
      </div>

      <IntegrityPanel integrity={integrity.data} page={page} />
      {integrity.isError && <Alert tone="danger">{errorMessage(integrity.error)}</Alert>}

      <Card>
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end" onSubmit={submit} aria-label="Denetim filtresi">
          <FormField label="Başlangıç">
            <Input type="date" value={draft.fromDay} onChange={(e) => setDraft({ ...draft, fromDay: e.target.value })} />
          </FormField>
          <FormField label="Bitiş">
            <Input type="date" value={draft.toDay} onChange={(e) => setDraft({ ...draft, toDay: e.target.value })} />
          </FormField>
          <FormField label="İşlem">
            <Select value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
              <option value="">Tümü</option>
              {AUDIT_CATEGORIES.map((c) => (
                <option key={c.prefix} value={c.prefix}>
                  {c.label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Yapan">
            {scope === 'apartment' && (people.data?.length ?? 0) > 0 ? (
              <Select value={draft.actorId} onChange={(e) => setDraft({ ...draft, actorId: e.target.value })}>
                <option value="">Herkes</option>
                {people.data?.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.fullName}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                placeholder="Kullanıcı kimliği"
                value={draft.actorId}
                onChange={(e) => setDraft({ ...draft, actorId: e.target.value })}
              />
            )}
          </FormField>
          <div className="flex gap-2">
            <Button type="submit" className="flex-1">
              <Filter className="size-4" aria-hidden="true" />
              Filtrele
            </Button>
            <Button type="button" variant="ghost" onClick={reset}>
              Temizle
            </Button>
          </div>
        </form>
      </Card>

      {log.isError && <Alert tone="danger">{errorMessage(log.error)}</Alert>}
      {log.isPending ? (
        <div role="status" aria-label="Kayıtlar yükleniyor" className="flex flex-col gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : entries.length === 0 && !log.isError ? (
        <Card className="flex flex-col items-center gap-2 py-12 text-center">
          <ScrollText className="size-8 text-muted" aria-hidden="true" />
          <p className="font-medium">Kayıt bulunamadı</p>
          <p className="text-small text-muted">Filtreyi genişletmeyi deneyin.</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Denetim kayıtları">
          {entries.map((e) => (
            <li key={e.seq}>
              <button
                type="button"
                onClick={() => setSelected(e)}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface/60 p-3 text-left shadow-sm hover:border-border-strong focus-visible:outline-2 focus-visible:outline-accent"
              >
                <CheckIcon check={page?.bySeq.get(e.seq)} />
                <span className="w-12 shrink-0 font-mono text-xs text-muted">#{e.seq}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{actionLabel(e.action)}</span>
                  <span className="block truncate text-small text-muted" title={`Kullanıcı kimliği: ${e.actor.userId}`}>
                    {actorText(e.actor, directory.get(e.actor.userId))}
                    {e.actor.supportSessionId ? ' · destek' : ''}
                    {e.reason ? ` · ${e.reason}` : ''}
                  </span>
                </span>
                <span className="hidden shrink-0 text-right text-small text-muted sm:block">
                  {formatDateTime(e.at)}
                  <span className="block font-mono text-xs">{shortHash(e.hash)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {log.hasNextPage && (
        <Button variant="secondary" className="self-center" onClick={() => void log.fetchNextPage()} loading={log.isFetchingNextPage}>
          Daha fazla yükle
        </Button>
      )}

      <Dialog open={!!selected} onClose={() => setSelected(undefined)} title={selected ? `Kayıt #${selected.seq}` : 'Kayıt'}>
        {selected && <EntryDetail entry={selected} check={page?.bySeq.get(selected.seq)} actor={directory.get(selected.actor.userId)} />}
      </Dialog>
    </div>
  );
}
