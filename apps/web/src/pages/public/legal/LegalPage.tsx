import { LEGAL_DOCUMENTS, LEGAL_DOCUMENT_ORDER, LEGAL_DRAFT_NOTICE, type LegalDocumentKey } from '@bm/shared/legal/documents';
import { useEffect } from 'react';
import { Badge } from '@/components/ui';
import { BRAND_NAME } from '@/lib/brand';
import { formatDate } from '@/lib/dates';
import { textLinkClass } from '../cta';
import { PublicFooter } from '../PublicFooter';
import { PublicHeader } from '../PublicHeader';

/**
 * Hukuki metin sayfasi (KVKK aydinlatma metni, gizlilik, kullanim kosullari). Metinler tek kaynaktan
 * (packages/shared/src/legal/documents.ts) gelir; bu bilesen yalnizca gosterir. Metinler TASLAK:
 * ustte her zaman "hukuki inceleme gerekir" uyarisi, altta surum ve son guncelleme tarihi.
 */
export function LegalPage({ docKey }: { docKey: LegalDocumentKey }) {
  const doc = LEGAL_DOCUMENTS[docKey];

  useEffect(() => {
    const previous = document.title;
    document.title = `${doc.title} (taslak) | ${BRAND_NAME}`;
    return () => {
      document.title = previous;
    };
  }, [doc.title]);

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <a
        href="#ana-icerik"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-small focus:font-medium focus:shadow-md focus:outline-2 focus:outline-accent"
      >
        İçeriğe geç
      </a>
      <PublicHeader demoHref="/#iletisim" />
      <main id="ana-icerik" tabIndex={-1} className="flex-1 focus:outline-none">
        <article className="mx-auto w-full max-w-content px-4 py-12 sm:px-6 lg:py-16">
          <div role="note" className="flex flex-col gap-2 rounded-lg border border-warning/20 bg-warning/10 px-4 py-3 text-small text-warning sm:flex-row sm:items-start">
            <Badge tone="warning" className="self-start">
              Taslak
            </Badge>
            <p>{LEGAL_DRAFT_NOTICE}</p>
          </div>

          <h1 className="mt-8 text-title font-bold tracking-tight text-text">{doc.title}</h1>
          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-small text-muted">
            <div className="flex gap-1">
              <dt>Sürüm:</dt>
              <dd className="font-mono text-xs leading-5">{doc.version}</dd>
            </div>
            <div className="flex gap-1">
              <dt>Son güncelleme:</dt>
              <dd>{formatDate(doc.updatedAt)}</dd>
            </div>
          </dl>
          <p className="mt-6 text-body text-text-secondary">{doc.summary}</p>

          {doc.sections.map((s) => (
            <section key={s.heading} className="mt-10">
              <h2 className="text-heading font-semibold text-text">{s.heading}</h2>
              {s.paragraphs?.map((p) => (
                <p key={p} className="mt-3 text-body leading-relaxed text-text-secondary">
                  {p}
                </p>
              ))}
              {s.items && (
                <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-body leading-relaxed text-text-secondary marker:text-muted">
                  {s.items.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              )}
            </section>
          ))}

          <nav aria-label="Diğer hukuki metinler" className="mt-12 border-t border-border pt-6">
            <ul className="flex flex-wrap gap-x-6 gap-y-2 text-small">
              {LEGAL_DOCUMENT_ORDER.filter((k) => k !== docKey).map((k) => (
                <li key={k}>
                  <a href={LEGAL_DOCUMENTS[k].path} className={textLinkClass}>
                    {LEGAL_DOCUMENTS[k].title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </article>
      </main>
      <PublicFooter />
    </div>
  );
}

export function KvkkPage() {
  return <LegalPage docKey="kvkk" />;
}

export function PrivacyPage() {
  return <LegalPage docKey="privacy" />;
}

export function TermsPage() {
  return <LegalPage docKey="terms" />;
}
