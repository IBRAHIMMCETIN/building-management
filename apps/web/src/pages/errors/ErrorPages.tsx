import type { ReactNode } from 'react';
import { Link, isRouteErrorResponse, useRouteError } from 'react-router';

function ErrorShell({ code, title, children }: { code: string; title: string; children?: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="flex max-w-content flex-col items-center gap-3 text-center">
        <p className="text-title font-bold text-accent">{code}</p>
        <h1 className="text-heading font-semibold">{title}</h1>
        {children}
        <Link to="/" className="text-accent underline-offset-4 hover:underline">
          Ana sayfaya dön
        </Link>
      </div>
    </main>
  );
}

export function NotFoundPage() {
  return <ErrorShell code="404" title="Sayfa bulunamadı" />;
}

export function ForbiddenPage() {
  return (
    <ErrorShell code="403" title="Bu sayfaya erişim yetkiniz yok">
      <p className="text-muted">Farklı bir apartman veya rol seçmeniz gerekebilir.</p>
    </ErrorShell>
  );
}

/** Router seviyesinde yakalanmayan hatalar (render/loader). */
export function RouteErrorPage() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  if (import.meta.env.DEV) console.error(error);
  return <ErrorShell code="Hata" title="Beklenmeyen bir sorun oluştu" />;
}
