import { Card, CardTitle } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { ROLE_LABELS } from '@/types/roles';

export function DashboardPage() {
  const { user } = useAuth();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title font-bold">Genel Bakış</h1>
      <Card>
        <CardTitle>Aktif bağlam</CardTitle>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-small">
          <dt className="text-muted">Rol</dt>
          <dd>{user?.role ? ROLE_LABELS[user.role] : '—'}</dd>
          <dt className="text-muted">Apartman</dt>
          <dd>
            <code>{user?.apartmentId ?? '—'}</code>
          </dd>
          {user?.organizationId && (
            <>
              <dt className="text-muted">Organizasyon</dt>
              <dd>
                <code>{user.organizationId}</code>
              </dd>
            </>
          )}
        </dl>
      </Card>
    </div>
  );
}
