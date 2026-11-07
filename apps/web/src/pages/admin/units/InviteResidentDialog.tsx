import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, MailCheck, UserCheck } from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, FormField, Input } from '@/components/ui';
import { useInviteResident } from '@/hooks/useUnits';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import { cn } from '@/lib/cn';
import { type InviteForm, type InviteValues, inviteSchema } from './schemas';
import type { UnitRow } from './unitRows';

type Props = { row: UnitRow | null; onClose: () => void };

const FIELDS = ['fullName', 'email', 'relation', 'startDate', 'residesInUnit', 'shareNumerator', 'shareDenominator'] as const;

const todayIstanbul = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

/** API'nin uyelik kurali mesajlarini (ASCII) kullanicinin anlayacagi dile cevirir. */
function friendlyMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'invitations_disabled') return 'Davet servisi bu ortamda henüz etkin değil. Sistem yöneticisine bildirin.';
    if (err.status === 409 && /zaten atanmis/i.test(err.message)) return 'Bu kişi bu daireye zaten atanmış.';
    if (err.status === 409 && /kiraci|oturan/i.test(err.message)) {
      return 'Bu dönemde dairede oturan başka biri var (oturan malik ile kiracı aynı anda olamaz). Önceki kaydın çıkış tarihini girin.';
    }
    if (err.status === 409 && /hisse|pay/i.test(err.message)) return "Maliklerin toplam hisse payı 1'i aşamaz.";
  }
  return errorMessage(err);
}

export function InviteResidentDialog({ row, onClose }: Props) {
  const invite = useInviteResident();
  const form = useForm<InviteForm, unknown, InviteValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { fullName: '', email: '', relation: 'tenant', startDate: todayIstanbul(), residesInUnit: false, shareNumerator: '', shareDenominator: '' },
  });
  const { errors } = form.formState;
  const relation = form.watch('relation');

  useEffect(() => {
    if (!row) return;
    invite.reset();
    // Kiracisi olan dairede varsayilan "malik", bos dairede "kiraci" daha olasi.
    form.reset({
      fullName: '',
      email: '',
      relation: row.tenants.length > 0 ? 'owner' : 'tenant',
      startDate: todayIstanbul(),
      residesInUnit: false,
      shareNumerator: '',
      shareDenominator: '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca daire degisince
  }, [row?.unit.unitId]);

  const submit = form.handleSubmit(async (v) => {
    if (!row) return;
    try {
      await invite.mutateAsync({
        unitId: row.unit.unitId,
        fullName: v.fullName,
        email: v.email,
        relation: v.relation,
        startDate: v.startDate,
        ...(v.relation === 'owner'
          ? {
              residesInUnit: v.residesInUnit,
              ...(v.shareNumerator !== undefined && v.shareDenominator !== undefined
                ? { ownershipShare: { numerator: v.shareNumerator, denominator: v.shareDenominator } }
                : {}),
            }
          : {}),
      });
    } catch (err) {
      applyApiFieldError(err, form.setError, FIELDS, { ownershipShare: 'shareNumerator' });
    }
  });

  const title = row ? `Sakin davet et · ${row.blockName} / ${row.unit.number}` : 'Sakin davet et';
  const done = invite.isSuccess ? invite.data : null;

  return (
    <Dialog open={row !== null} onClose={() => !invite.isPending && onClose()} title={title}>
      {done ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          {done.invitation === 'sent' ? (
            <MailCheck className="size-10 text-success" aria-hidden="true" />
          ) : (
            <UserCheck className="size-10 text-success" aria-hidden="true" />
          )}
          <p className="font-semibold">{done.person.fullName} daireye eklendi</p>
          <p className="text-small text-muted">
            {done.invitation === 'sent'
              ? `${done.person.email} adresine giriş bilgileri gönderildi. İlk girişte kendi şifresini belirleyecek.`
              : 'Bu kişinin zaten bir hesabı var; yeni bir e-posta gönderilmedi. Giriş yaptığında bu daireyi görecek.'}
          </p>
          <div className="flex w-full flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-center">
            <Button variant="secondary" onClick={() => { invite.reset(); form.reset({ ...form.getValues(), fullName: '', email: '' }); }}>
              Başka kişi ekle
            </Button>
            <Button onClick={onClose}>
              <CheckCircle2 className="size-4" aria-hidden="true" />
              Tamam
            </Button>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          {invite.isError && !Object.values(errors).some((e) => e?.type === 'server') && (
            <Alert tone="danger">{friendlyMessage(invite.error)}</Alert>
          )}

          <fieldset>
            <legend className="mb-1.5 text-small font-medium">Daireyle ilişkisi</legend>
            <div className="grid grid-cols-2 gap-2" role="radiogroup">
              {(['tenant', 'owner'] as const).map((value) => (
                <label
                  key={value}
                  className={cn(
                    'flex cursor-pointer items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-small font-medium',
                    'has-checked:border-accent has-checked:bg-accent/10 has-checked:text-accent',
                    'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent',
                  )}
                >
                  <input type="radio" value={value} className="sr-only" {...form.register('relation')} />
                  {value === 'tenant' ? 'Kiracı' : 'Malik (ev sahibi)'}
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-small text-muted">
              {relation === 'tenant'
                ? 'Aidat ve işletme giderleri kiracının carisine yazılır.'
                : 'Demirbaş ve yatırım giderleri malikin carisine yazılır.'}
            </p>
          </fieldset>

          <FormField label="Ad soyad" error={errors.fullName?.message}>
            <Input autoComplete="off" autoFocus {...form.register('fullName')} />
          </FormField>
          <FormField label="E-posta" error={errors.email?.message} hint="Giriş bilgileri bu adrese gönderilir.">
            <Input type="email" inputMode="email" autoComplete="off" {...form.register('email')} />
          </FormField>
          <FormField label={relation === 'tenant' ? 'Taşınma tarihi' : 'Mülkiyet başlangıcı'} error={errors.startDate?.message}>
            <Input type="date" {...form.register('startDate')} />
          </FormField>

          {relation === 'owner' && (
            <>
              <label className="flex items-start gap-2 text-small">
                <input type="checkbox" className="mt-0.5 size-4 accent-accent" {...form.register('residesInUnit')} />
                <span>
                  Malik bu dairede oturuyor
                  <span className="block text-muted">Kiracı yokken işletme giderleri de malike yazılır.</span>
                </span>
              </label>
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1.5 text-small font-medium">
                  Hisse payı <span className="font-normal text-muted">(hisseli mülkiyette)</span>
                </legend>
                <div className="flex items-start gap-2">
                  <Input aria-label="Hisse payı (pay)" inputMode="numeric" placeholder="1" invalid={!!errors.shareNumerator} {...form.register('shareNumerator')} />
                  <span className="pt-2 text-muted" aria-hidden="true">
                    /
                  </span>
                  <Input aria-label="Hisse payı (payda)" inputMode="numeric" placeholder="2" invalid={!!errors.shareDenominator} {...form.register('shareDenominator')} />
                </div>
                {(errors.shareNumerator || errors.shareDenominator) && (
                  <p role="alert" className="text-small text-danger">
                    {errors.shareNumerator?.message ?? errors.shareDenominator?.message}
                  </p>
                )}
              </fieldset>
            </>
          )}

          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose} disabled={invite.isPending}>
              Vazgeç
            </Button>
            <Button type="submit" loading={invite.isPending}>
              Davet gönder
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
