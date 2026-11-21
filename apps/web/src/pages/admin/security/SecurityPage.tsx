import { useQuery } from '@tanstack/react-query';
import { Search, ShieldCheck, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { MfaResetDialog } from '@/components/security/MfaResetDialog';
import { Alert, Badge, Button, Card, Input, Skeleton } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { usePeople } from '@/hooks/useUnits';
import { apartmentRolesApi } from '@/lib/api/apartmentRoles';
import { errorMessage } from '@/lib/api/errors';
import { roleLabel } from '@/lib/audit/labels';

export type SecurityPerson = { userId: string; name: string; email?: string; roles: string[] };

/** Kisiler (sakinler) ve gorev rolleri tek listede: kullanici basina tek satir. */
export function mergePeople(
  people: readonly { userId: string; fullName: string; email: string }[],
  roles: readonly { userId: string; role: string; displayName?: string }[],
): SecurityPerson[] {
  const byId = new Map<string, SecurityPerson>();
  for (const p of people) byId.set(p.userId, { userId: p.userId, name: p.fullName, email: p.email, roles: ['resident'] });
  for (const r of roles) {
    const existing = byId.get(r.userId);
    if (existing) {
      if (!existing.roles.includes(r.role)) existing.roles.push(r.role);
    } else {
      byId.set(r.userId, { userId: r.userId, name: r.displayName ?? r.userId, roles: [r.role] });
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}

/**
 * Apartman guvenligi: kisilerin iki adimli dogrulama durumu ve cihaz kaybinda denetimli
 * sifirlama (apartman yoneticisi / yonetim firmasi). Durum tek tek, istek uzerine okunur.
 */
export function SecurityPage() {
  const { user } = useAuth();
  const people = usePeople();
  const roles = useQuery({
    queryKey: ['apartment-roles', 'current', user?.apartmentId],
    queryFn: ({ signal }) => apartmentRolesApi.listCurrent(signal).then((r) => r.items),
    enabled: !!user?.apartmentId,
  });
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<SecurityPerson>();

  const all = useMemo(() => mergePeople(people.data ?? [], roles.data ?? []), [people.data, roles.data]);
  const needle = q.trim().toLocaleLowerCase('tr');
  const items = needle
    ? all.filter((p) => p.name.toLocaleLowerCase('tr').includes(needle) || p.email?.toLocaleLowerCase('tr').includes(needle))
    : all;
  const loading = people.isPending || roles.isPending;
  const error = people.error ?? roles.error;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-title font-bold">Güvenlik</h1>
        <p className="text-small text-muted">
          Yönetici ve denetçiler için iki adımlı doğrulama zorunludur. Telefonunu kaybeden bir kullanıcının doğrulayıcısını
          gerekçe yazarak sıfırlayabilirsiniz; işlem denetim günlüğüne yazılır ve kullanıcının tüm oturumları kapanır.
        </p>
      </div>

      <Alert tone="info">
        Başka bir apartmanda yönetici/denetçi olan kullanıcıların ve platform yöneticilerinin doğrulayıcısı yalnızca platform
        ekibi tarafından sıfırlanabilir. Kendi doğrulayıcınızı sıfırlayamazsınız.
      </Alert>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
        <Input className="pl-9" placeholder="Ad veya e-posta ara" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Kişi ara" />
      </div>

      {error && <Alert tone="danger">{errorMessage(error)}</Alert>}
      {loading ? (
        <div role="status" aria-label="Kişiler yükleniyor" className="flex flex-col gap-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-10 text-center">
          <Users className="size-8 text-muted" aria-hidden="true" />
          <p className="font-medium">Kişi bulunamadı</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Kişiler">
          {items.map((p) => (
            <li
              key={p.userId}
              className="flex flex-col gap-2 rounded-xl border border-border bg-surface/60 p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{p.name}</p>
                <div className="flex flex-wrap items-center gap-1 text-small text-muted">
                  {p.email && <span className="truncate">{p.email}</span>}
                  {p.roles.map((r) => (
                    <Badge key={r} tone={r === 'resident' ? 'neutral' : 'accent'}>
                      {roleLabel(r)}
                    </Badge>
                  ))}
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                disabled={p.userId === user?.sub}
                title={p.userId === user?.sub ? 'Kendi doğrulayıcınızı sıfırlayamazsınız' : undefined}
                onClick={() => setSelected(p)}
              >
                <ShieldCheck className="size-4" aria-hidden="true" />
                2FA durumu / sıfırla
              </Button>
            </li>
          ))}
        </ul>
      )}

      <MfaResetDialog userId={selected?.userId} displayName={selected?.name} onClose={() => setSelected(undefined)} />
    </div>
  );
}
