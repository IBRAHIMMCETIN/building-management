import { errorMessage } from '@bm/shared/api/errors';
import {
  type MyPlanRequest,
  PARTY_LABELS,
  PLAN_REQUEST_BLOCK_TEXT,
  PLAN_REQUEST_NOTE_MAX,
  PLAN_REQUEST_STATUS_LABELS,
  PLAN_REQUEST_STATUS_TONES,
  installmentChoices,
  monthlyAmount,
} from '@bm/shared/api/planRequests';
import { formatDate, formatDateTime } from '@bm/shared/dates';
import { formatTRY } from '@bm/shared/money';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { CalendarClock } from '@/components/icons';
import { Alert, AppText, Badge, Button, Card, CardTitle, ChipGroup, TextField } from '@/components/ui';
import { useCreatePlanRequest, useMyPlanRequests, usePlanRequestOptions, useWithdrawPlanRequest } from '@/hooks/usePlanRequests';
import { useIdempotencyKey } from '@/lib/idempotency';
import { radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/** Talep satirinin alt bilgisi (web: components/portal/RestructureRequestCard.tsx `requestDetail` ile ayni metin). */
export function requestDetail(r: MyPlanRequest): string {
  const d = r.decision;
  if (r.status === 'approved' && d) {
    const changed = d.mode === 'changed' ? ' (yönetim değiştirerek onayladı)' : '';
    return `${d.installments ?? r.installments} taksit${d.firstDueDate ? `, ilk taksit ${formatDate(d.firstDueDate)}` : ''}${changed}`;
  }
  if (r.status === 'rejected' && d) return `Gerekçe: ${d.reason}`;
  return `${r.installments} taksit istendi · yaklaşık ${formatTRY(r.estimate.total)}`;
}

/**
 * Borçlarım'da taksit (yapilandirma) talebi (web: components/portal/RestructureRequestCard.tsx):
 * gecikmis borc icin yonetimin sinirlari icinde taksit sayisi secilir, talebin durumu izlenir,
 * bekleyen talep geri cekilir. Talep edilecek borc ve talep yoksa (veya ozellik kapaliysa) gizli.
 */
export function RestructureRequestCard() {
  const options = usePlanRequestOptions();
  const requests = useMyPlanRequests();
  const create = useCreatePlanRequest();
  const withdraw = useWithdrawPlanRequest();
  const [key, renewKey] = useIdempotencyKey();
  const { colors } = useTheme();
  const [accountId, setAccountId] = useState('');
  const [installments, setInstallments] = useState(0);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);

  // Yonetim talep almiyorsa (varsayilan) veya ozellik kapaliysa secenekler 403: form yok, gecmis talepler gorunur.
  const o = options.isError ? undefined : options.data;
  const eligible = o?.settings.enabled ? o.accounts.filter((a) => a.eligible) : [];
  const account = eligible.find((a) => a.accountId === accountId) ?? eligible[0];
  const choices = account ? installmentChoices(account, o?.minInstallments) : [];
  useEffect(() => {
    if (!account) return;
    setInstallments((cur) => (choices.includes(cur) ? cur : (choices[Math.min(1, choices.length - 1)] ?? 0)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.accountId, account?.maxInstallments]);

  const list = requests.data ?? [];
  const notices = (o?.accounts ?? []).filter(
    (a) => !a.eligible && a.reason && a.reason !== 'no_overdue' && a.reason !== 'disabled' && !(a.reason === 'pending_request' && a.pendingRequest === 'mine'),
  );
  if (eligible.length === 0 && list.length === 0 && notices.length === 0) return null;
  const valid = !!account && choices.includes(installments);

  const submit = async () => {
    if (!valid || !account) return;
    try {
      await create.mutateAsync({ idempotencyKey: key, liableParty: account.liableParty, installments, ...(note.trim() ? { note: note.trim() } : {}) });
      setSent(true);
      setNote('');
      setAccountId('');
      renewKey();
    } catch {
      // asagida gosterilir
    }
  };

  return (
    <Card>
      <CardTitle icon={<CalendarClock size={20} color={colors.muted} aria-hidden />}>Taksit talebi</CardTitle>
      {account && o && (
        <>
          <AppText variant="small" tone="muted">
            Gecikmiş borcunuzu taksitle ödemek istiyorsanız talep gönderin. Yönetim olduğu gibi veya değiştirerek onaylar; vade farkı uygulanmaz.
          </AppText>
          {eligible.length > 1 && (
            <ChipGroup
              label="Hangi borç için?"
              value={account.accountId}
              options={eligible.map((a) => ({ value: a.accountId, label: PARTY_LABELS[a.liableParty] }))}
              onChange={setAccountId}
            />
          )}
          <View style={[styles.box, { backgroundColor: colors.surfaceMuted }]} accessible accessibilityLabel={`Taksitlenecek tutar yaklaşık ${formatTRY(account.total)}`}>
            <AppText variant="small" tone="muted">
              {`Gecikmiş borç ${formatTRY(account.overdue)}${o.settings.includeLateFees && account.accruedLateFee > 0 ? ` + işleyen tazminat ${formatTRY(account.accruedLateFee)}` : ''}`}
            </AppText>
            <AppText weight="semibold" tabular>{`Taksitlenecek: yaklaşık ${formatTRY(account.total)}`}</AppText>
          </View>
          <AppText variant="small" weight="medium">
            Taksit sayısı
          </AppText>
          <ChipGroup
            label="Taksit sayısı"
            value={String(installments)}
            options={choices.map((n) => ({ value: String(n), label: `${n} taksit` }))}
            onChange={(v) => setInstallments(Number(v))}
          />
          {valid && (
            <AppText variant="small" tone="muted">
              {`Aylık yaklaşık ${formatTRY(monthlyAmount(account.total, installments))} (en fazla ${account.maxInstallments} taksit, bir taksit en az ${formatTRY(o.settings.minInstallmentAmount)})`}
            </AppText>
          )}
          <TextField label="Not (isteğe bağlı)" value={note} onChangeText={setNote} maxLength={PLAN_REQUEST_NOTE_MAX} multiline />
          {create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
          <Button label="Talep gönder" block loading={create.isPending} disabled={!valid} onPress={() => void submit()} />
        </>
      )}
      {sent && !create.isError && <Alert tone="success">Talebiniz yönetime iletildi. Sonucu burada ve bildirimle göreceksiniz.</Alert>}
      {notices.map((a) => (
        <AppText key={a.accountId} variant="small" tone="muted">
          {`${eligible.length > 0 || notices.length > 1 ? `${PARTY_LABELS[a.liableParty]}: ` : ''}${PLAN_REQUEST_BLOCK_TEXT[a.reason as keyof typeof PLAN_REQUEST_BLOCK_TEXT]}`}
        </AppText>
      ))}
      {withdraw.isError && <Alert tone="danger">{errorMessage(withdraw.error)}</Alert>}
      {list.length > 0 && (
        <View style={styles.list} accessibilityLabel="Taksit taleplerim">
          {list.map((r) => (
            <View key={r.requestId} style={[styles.row, { borderColor: colors.border }]}>
              <View style={styles.between}>
                <View style={styles.flex}>
                  <AppText variant="small">{requestDetail(r)}</AppText>
                  <AppText variant="small" tone="muted">
                    {formatDateTime(r.createdAt)}
                  </AppText>
                </View>
                <Badge tone={PLAN_REQUEST_STATUS_TONES[r.status]} label={PLAN_REQUEST_STATUS_LABELS[r.status]} />
              </View>
              {r.status === 'pending' && (
                <Button
                  label="Geri çek"
                  variant="ghost"
                  loading={withdraw.isPending && withdraw.variables === r.requestId}
                  onPress={() => withdraw.mutate(r.requestId)}
                  accessibilityLabel="Taksit talebini geri çek"
                />
              )}
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: radii.md, padding: space(3), gap: 2 },
  list: { gap: space(2) },
  row: { borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: radii.md, padding: space(3), gap: space(1.5) },
  between: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space(3) },
  flex: { flex: 1 },
});
