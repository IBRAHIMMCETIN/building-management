import { MailPlus, Send, UserMinus, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Dialog, FilterChips, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { useEndRole, useInviteMember, useResendInvite, useTeam, useTeamPermissions } from '@/hooks/useTeam';
import type { ApartmentRoleView, StaffRole } from '@/lib/api/apartmentRoles';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { formatDate } from '@/lib/dates';
import {
  GRANTABLE_BY,
  type InviteDraft,
  TEAM_ROLE_HINTS,
  TEAM_STATUS_META,
  canManageRecord,
  endReasonError,
  inviteErrors,
  isLastManager,
  personName,
  teamStatus,
} from '@/lib/team/model';
import { ROLE_LABELS, isRole } from '@/types/roles';

type Filter = 'active' | 'ended' | 'all';

const todayIstanbul = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
const roleText = (role: string) => (isRole(role) ? ROLE_LABELS[role] : role);

/**
 * Faz 1 - Ekip: yonetici, yonetim firmasi, denetci, bina gorevlisi ve guvenlik rolleri.
 * E-postayla davet, gerekceli rol bitirme, davet yenileme. Denetci salt okunur gorur
 * (e-postalar maskeli). Son yonetici korumasi API'dedir; arayuz ayrica uyarir.
 */
export function TeamPage() {
  const { canRead, canWrite } = useTeamPermissions();
  const { user } = useAuth();
  const team = useTeam();
  const [filter, setFilter] = useState<Filter>('active');
  const [inviting, setInviting] = useState(false);
  const [ending, setEnding] = useState<ApartmentRoleView | null>(null);
  const resend = useResendInvite();
  const [resendNote, setResendNote] = useState<{ key: string; text: string; tone: 'success' | 'danger' } | null>(null);
  const today = todayIstanbul();

  const all = team.data ?? [];
  const rows = useMemo(
    () =>
      all
        .filter((r) => {
          const ended = teamStatus(r, today) === 'ended';
          return filter === 'all' || (filter === 'ended' ? ended : !ended);
        })
        .sort((a, b) => roleText(a.role).localeCompare(roleText(b.role), 'tr') || personName(a).localeCompare(personName(b), 'tr')),
    [all, filter, today],
  );
  const activeCount = all.filter((r) => teamStatus(r, today) !== 'ended').length;

  if (!canRead) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-title font-bold">Ekip</h1>
        <Alert>Bu rol ekip kayıtlarını görüntüleyemez.</Alert>
      </div>
    );
  }

  const runResend = async (r: ApartmentRoleView) => {
    const key = `${r.userId}:${r.role}`;
    setResendNote(null);
    try {
      const out = await resend.mutateAsync({ userId: r.userId, role: r.role });
      setResendNote({
        key,
        tone: 'success',
        text: out.result === 'sent' ? 'Davet e-postası yeniden gönderildi.' : 'Kişi hesabını zaten etkinleştirmiş; yeni davet gerekmiyor.',
      });
    } catch (err) {
      setResendNote({ key, tone: 'danger', text: errorMessage(err) });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-title font-bold">Ekip</h1>
          <p className="text-small text-muted">
            Yönetici, denetçi, bina görevlisi ve güvenlik rolleri. Değişiklikler kişinin bir sonraki oturum yenilemesinde geçerli olur.
          </p>
        </div>
        {canWrite && (
          <Button onClick={() => setInviting(true)}>
            <MailPlus className="size-4" aria-hidden="true" />
            Ekibe davet et
          </Button>
        )}
      </div>

      <FilterChips<Filter>
        label="Ekip durumu"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'active', label: 'Aktif', count: activeCount },
          { value: 'ended', label: 'Sona erenler' },
          { value: 'all', label: 'Tümü' },
        ]}
      />

      {team.isError && <Alert tone="danger">{errorMessage(team.error)}</Alert>}
      {team.isPending && <Skeleton className="h-32 w-full" />}
      {team.isSuccess && rows.length === 0 && (
        <Card className="flex flex-col items-center gap-2 py-10 text-center">
          <Users className="size-8 text-muted" aria-hidden="true" />
          <p className="font-medium">{filter === 'ended' ? 'Sona eren rol yok' : 'Ekipte kimse yok'}</p>
        </Card>
      )}

      {rows.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Ekip üyeleri">
          {rows.map((r) => {
            const status = teamStatus(r, today);
            const meta = TEAM_STATUS_META[status];
            const key = `${r.userId}:${r.role}`;
            const manageable = canWrite && canManageRecord({ role: user?.role, userId: user?.sub }, r);
            const isSelf = r.userId === user?.sub;
            return (
              <li key={key}>
                <Card className="flex flex-wrap items-start justify-between gap-3 p-4 md:p-4">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-semibold">
                      {personName(r)}
                      {isSelf && <Badge tone="accent">Siz</Badge>}
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </p>
                    <p className="text-small text-muted">
                      {roleText(r.role)}
                      {r.email ? ` · ${r.email}` : ''}
                    </p>
                    <p className="text-small text-muted">
                      {r.startDate ? `Başlangıç ${formatDate(r.startDate)}` : ''}
                      {r.endDate ? ` · Bitiş ${formatDate(r.endDate)}` : ''}
                      {r.endReason ? ` · Gerekçe: ${r.endReason}` : ''}
                    </p>
                    {resendNote?.key === key && (
                      <p role="status" className={resendNote.tone === 'success' ? 'mt-1 text-small text-success' : 'mt-1 text-small text-danger'}>
                        {resendNote.text}
                      </p>
                    )}
                  </div>
                  {manageable && status !== 'ended' && (
                    <div className="flex flex-wrap gap-2">
                      {r.email && (
                        <Button size="sm" variant="ghost" loading={resend.isPending && resend.variables?.userId === r.userId} onClick={() => void runResend(r)}>
                          <Send className="size-4" aria-hidden="true" />
                          Daveti yeniden gönder
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setEnding(r)}>
                        <UserMinus className="size-4" aria-hidden="true" />
                        Rolü bitir
                      </Button>
                    </div>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {canWrite && (
        <>
          <InviteDialog open={inviting} onClose={() => setInviting(false)} />
          <EndRoleDialog record={ending} records={all} onClose={() => setEnding(null)} />
        </>
      )}
    </div>
  );
}

function inviteMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'invitations_disabled') return 'Davet servisi bu ortamda henüz etkin değil. Sistem yöneticisine bildirin.';
    if (err.status === 409) return 'Bu kişi bu rolle zaten ekipte.';
  }
  return errorMessage(err);
}

export function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { role } = useTeamPermissions();
  const invite = useInviteMember();
  const grantable = (role ? GRANTABLE_BY[role] : undefined) ?? [];
  const empty = (): InviteDraft => ({ fullName: '', email: '', role: '', startDate: todayIstanbul(), endDate: '' });
  const [draft, setDraft] = useState<InviteDraft>(empty);
  const [touched, setTouched] = useState(false);
  const errors = inviteErrors(draft);
  const show = (k: keyof InviteDraft) => (touched ? errors[k] : undefined);

  useEffect(() => {
    if (!open) return;
    setDraft(empty());
    setTouched(false);
    invite.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open]);

  const submit = async () => {
    setTouched(true);
    if (Object.keys(errors).length > 0 || !draft.role) return;
    try {
      await invite.mutateAsync({
        fullName: draft.fullName.trim(),
        email: draft.email.trim(),
        role: draft.role,
        startDate: draft.startDate,
        ...(draft.endDate ? { endDate: draft.endDate } : {}),
      });
    } catch {
      // asagida gosterilir
    }
  };

  const done = invite.data;
  return (
    <Dialog open={open} onClose={() => !invite.isPending && onClose()} title="Ekibe davet et" className="max-w-lg">
      {done ? (
        <div className="flex flex-col gap-3">
          <Alert tone="success">
            {done.invitation === 'sent'
              ? `${done.role.email ?? 'Kişiye'} geçici şifre içeren davet e-postası gönderildi.`
              : 'Kişinin hesabı zaten vardı; yeni rol bir sonraki girişinde görünür (e-posta gönderilmedi).'}
            {done.reactivated ? ' Daha önce sona eren rolü yeniden etkinleştirildi.' : ''}
          </Alert>
          {done.mock?.temporaryPassword && <p className="text-small text-muted">Yerel test şifresi: {done.mock.temporaryPassword}</p>}
          <div className="flex justify-end">
            <Button onClick={onClose}>Tamam</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <FormField label="Ad soyad" error={show('fullName')}>
            <Input value={draft.fullName} maxLength={100} onChange={(e) => setDraft({ ...draft, fullName: e.target.value })} aria-label="Ad soyad" />
          </FormField>
          <FormField label="E-posta" error={show('email')} hint="Geçici şifre bu adrese gider; kişi ilk girişte kendi şifresini belirler.">
            <Input type="email" value={draft.email} maxLength={254} onChange={(e) => setDraft({ ...draft, email: e.target.value })} aria-label="E-posta" />
          </FormField>
          <FormField label="Rol" error={show('role')} hint={draft.role ? TEAM_ROLE_HINTS[draft.role] : undefined}>
            <Select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as StaffRole | '' })} aria-label="Rol">
              <option value="">Seçin</option>
              {grantable.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Başlangıç" error={show('startDate')}>
              <Input type="date" value={draft.startDate} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} aria-label="Başlangıç" />
            </FormField>
            <FormField label="Bitiş (isteğe bağlı)" error={show('endDate')}>
              <Input type="date" value={draft.endDate} onChange={(e) => setDraft({ ...draft, endDate: e.target.value })} aria-label="Bitiş" />
            </FormField>
          </div>
          {(draft.role === 'apartment_manager' || draft.role === 'observer' || draft.role === 'management_company') && (
            <p className="text-small text-muted">Bu rolde iki adımlı doğrulama zorunludur; kişi ilk girişte kurulum ekranına yönlendirilir.</p>
          )}
          {invite.isError && <Alert tone="danger">{inviteMessage(invite.error)}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={invite.isPending}>
              Vazgeç
            </Button>
            <Button loading={invite.isPending} onClick={() => void submit()}>
              <MailPlus className="size-4" aria-hidden="true" />
              Davet gönder
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function EndRoleDialog({ record, records, onClose }: { record: ApartmentRoleView | null; records: readonly ApartmentRoleView[]; onClose: () => void }) {
  const end = useEndRole();
  const today = todayIstanbul();
  const [reason, setReason] = useState('');
  const [endDate, setEndDate] = useState(today);
  const [touched, setTouched] = useState(false);
  const reasonErr = endReasonError(reason);
  const last = record ? isLastManager(records, record, today) : false;

  useEffect(() => {
    if (!record) return;
    setReason('');
    setEndDate(todayIstanbul());
    setTouched(false);
    end.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [record?.userId, record?.role]);

  const submit = async () => {
    setTouched(true);
    if (!record || reasonErr || !endDate || record.version === undefined) return;
    try {
      await end.mutateAsync({ userId: record.userId, role: record.role, input: { version: record.version, reason: reason.trim(), endDate } });
      onClose();
    } catch {
      // asagida gosterilir
    }
  };

  return (
    <Dialog open={!!record} onClose={() => !end.isPending && onClose()} title="Rolü bitir" className="max-w-lg">
      {record && (
        <div className="flex flex-col gap-3">
          <p className="text-small">
            <strong>{personName(record)}</strong> · {roleText(record.role)}
          </p>
          <p className="text-small text-muted">
            Bitiş bugün veya geçmişteyse erişim hemen kapanır; ileri bir tarih seçerseniz o gün sona erer. Kayıt silinmez, gerekçeyle denetim günlüğüne
            yazılır.
          </p>
          {last && <Alert tone="danger">Bu kişi apartmanın tek aktif yöneticisi. Önce yeni bir yönetici davet edin.</Alert>}
          <FormField label="Bitiş tarihi">
            <Input type="date" value={endDate} min={record.startDate} onChange={(e) => setEndDate(e.target.value)} aria-label="Bitiş tarihi" />
          </FormField>
          <FormField label="Gerekçe" error={touched ? reasonErr : undefined}>
            <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Örn. Görev süresi doldu" />
          </FormField>
          {end.isError && <Alert tone="danger">{errorMessage(end.error)}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={end.isPending}>
              Vazgeç
            </Button>
            <Button variant="danger" loading={end.isPending} disabled={last} onClick={() => void submit()}>
              <UserMinus className="size-4" aria-hidden="true" />
              Rolü bitir
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
