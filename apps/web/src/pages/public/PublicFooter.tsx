import { LEGAL_DOCUMENTS, LEGAL_DOCUMENT_ORDER } from '@bm/shared/legal/documents';
import { BrandMark, BrandWordmark } from '@/components/BrandMark';
import { BRAND_NAME, BRAND_TAGLINE } from '@/lib/brand';
import { textLinkClass } from './cta';

/** Tanitim ve hukuki sayfalarin alt bilgisi: marka, kisa tanim, hukuki metinler, giris. */
export function PublicFooter() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto grid w-full max-w-page gap-8 px-4 py-12 sm:px-6 md:grid-cols-4 lg:px-8">
        <div className="flex max-w-md flex-col gap-3 md:col-span-2">
          <div className="flex items-center gap-2">
            <BrandMark className="size-8" />
            <BrandWordmark className="text-heading" />
          </div>
          <p className="text-small text-text-secondary">
            {BRAND_TAGLINE}. Apartman, site ve toplu konut yönetimleri için aidat, muhasebe, arıza ve bakım, güvenlik kapısı ve genel kurul işleri tek yerde.
          </p>
        </div>
        <nav aria-label="Hukuki metinler">
          <h2 className="text-small font-semibold text-text">Hukuki</h2>
          <ul className="mt-3 flex flex-col gap-2 text-small">
            {LEGAL_DOCUMENT_ORDER.map((key) => (
              <li key={key}>
                <a href={LEGAL_DOCUMENTS[key].path} className={textLinkClass}>
                  {LEGAL_DOCUMENTS[key].title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Hesap">
          <h2 className="text-small font-semibold text-text">Hesap</h2>
          <ul className="mt-3 flex flex-col gap-2 text-small">
            <li>
              <a href="/login" className={textLinkClass}>
                Giriş yap
              </a>
            </li>
            <li>
              <a href="/#iletisim" className={textLinkClass}>
                Demo talep et
              </a>
            </li>
          </ul>
        </nav>
      </div>
      <div className="border-t border-border">
        <p className="mx-auto w-full max-w-page px-4 py-4 text-xs text-muted sm:px-6 lg:px-8">
          © <span suppressHydrationWarning>{new Date().getFullYear()}</span> {BRAND_NAME}. Tüm hakları saklıdır.
        </p>
      </div>
    </footer>
  );
}
