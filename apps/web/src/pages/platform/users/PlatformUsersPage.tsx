import { Search, ShieldCheck, UserRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { MfaResetDialog, MfaStatusBadges } from '@/components/security/MfaResetDialog';
import { Alert, Button, Card, FormField, Input, Spinner } from '@/components/ui';
import { useFindMfaUser } from '@/hooks/useSecurity';
import { ApiError, errorMessage } from '@/lib/api/errors';

/**
 * Platform: kullanici arama ve iki adimli dogrulama sifirlama (herkes icin; kendisi haric).
 * Islem platform denetim zincirine yazilir. Apartman verisi burada gosterilmez.
 */
export function PlatformUsersPage() {
  const [email, setEmail] = useState('');
  const [searched, setSearched] = useState<string>();
  const [resetOpen, setResetOpen] = useState(false);
  const found = useFindMfaUser(searched);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (value) setSearched(value);
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-title font-bold">Kullanıcılar</h1>
        <p className="text-small text-muted">
          E-postayla kullanıcı bulun, iki adımlı doğrulama durumunu görün ve cihaz kaybında gerekçeyle sıfırlayın. Sıfırlama
          platform denetim zincirine yazılır.
        </p>
      </div>

      <Card>
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={submit} aria-label="Kullanıcı ara">
          <div className="flex-1">
            <FormField label="E-posta">
              <Input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ornek@site.com" />
            </FormField>
          </div>
          <Button type="submit" loading={found.isFetching}>
            <Search className="size-4" aria-hidden="true" />
            Ara
          </Button>
        </form>
      </Card>

      {found.isFetching && !found.data && <Spinner label="Aranıyor…" />}
      {found.isError &&
        (found.error instanceof ApiError && found.error.status === 404 ? (
          <Alert tone="info">Bu e-postaya ait kullanıcı bulunamadı.</Alert>
        ) : (
          <Alert tone="danger">{errorMessage(found.error)}</Alert>
        ))}

      {found.data && (
        <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <UserRound className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden="true" />
            <div className="flex flex-col gap-2">
              <div>
                <p className="font-medium">{found.data.email ?? searched}</p>
                <p className="font-mono text-xs text-muted">{found.data.userId}</p>
              </div>
              <MfaStatusBadges user={found.data} />
            </div>
          </div>
          <Button variant="secondary" onClick={() => setResetOpen(true)} disabled={!found.data.canReset} title={found.data.blockedReason}>
            <ShieldCheck className="size-4" aria-hidden="true" />
            2FA sıfırla
          </Button>
        </Card>
      )}

      <MfaResetDialog
        userId={resetOpen ? found.data?.userId : undefined}
        initial={found.data}
        displayName={found.data?.email}
        onClose={() => {
          setResetOpen(false);
          void found.refetch();
        }}
      />
    </div>
  );
}
