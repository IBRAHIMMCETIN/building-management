import { LEGAL_DOCUMENTS, LEGAL_DOCUMENT_ORDER } from '@bm/shared/legal/documents';
import { BrandMark, BrandWordmark } from '@/components/BrandMark';
import { BRAND_NAME, BRAND_TAGLINE } from '@/lib/brand';
import { textLinkClass } from './cta';

type NavLink = { href: string; label: string };

/** Alt bilgi sutunu: her biri kendi adiyla bir gezinme bolgesi (ekran okuyucu yer imleri listesinde ayri). */
function LinkColumn({ title, label, links }: { title: string; label: string; links: readonly NavLink[] }) {
  return (
    <nav aria-label={label}>
      <h2 className="text-small font-semibold text-text">{title}</h2>
      <ul className="mt-3 flex flex-col gap-2 text-small">
        {links.map((l) => (
          <li key={l.href}>
            <a href={l.href} className={textLinkClass}>
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Tanitim ve hukuki sayfalarin alt bilgisi: marka ve kisa tanim, sayfa bolumleri (yalnizca tanitim
 * sayfasinda, `links`), hesap baglantilari, hukuki metinler, telif yili ve verilerin saklandigi bolge.
 */
export function PublicFooter({ links = [], demoHref = '#iletisim' }: { links?: readonly NavLink[]; demoHref?: string }) {
  const legal = LEGAL_DOCUMENT_ORDER.map((key) => ({ href: LEGAL_DOCUMENTS[key].path, label: LEGAL_DOCUMENTS[key].title }));
  const account = [
    { href: '/login', label: 'Giriş yap' },
    { href: demoHref, label: 'Demo talep et' },
  ];
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto grid w-full max-w-page gap-10 px-4 py-12 sm:px-6 md:grid-cols-12 lg:px-8">
        <div className="flex max-w-sm flex-col gap-3 md:col-span-12 lg:col-span-5">
          <div className="flex items-center gap-2">
            <BrandMark small className="size-8" />
            <BrandWordmark className="text-heading" />
          </div>
          <p className="text-small text-text-secondary">
            {BRAND_TAGLINE}. Çok bloklu siteler ve toplu konutlar için aidat, tahsilat, arıza ve bakım, güvenlik kapısı ve genel kurul işleri
            tek yerde.
          </p>
        </div>
        <div className="grid gap-8 sm:grid-cols-3 md:col-span-12 lg:col-span-7">
          {links.length > 0 && <LinkColumn title="Sayfa" label="Sayfa bölümleri, alt bilgi" links={links} />}
          <LinkColumn title="Hesap" label="Hesap" links={account} />
          <LinkColumn title="Hukuki" label="Hukuki metinler" links={legal} />
        </div>
      </div>
      <div className="border-t border-border">
        <div className="mx-auto flex w-full max-w-page flex-col gap-1 px-4 py-4 text-xs text-muted sm:flex-row sm:justify-between sm:px-6 lg:px-8">
          <p>
            © <span suppressHydrationWarning>{new Date().getFullYear()}</span> {BRAND_NAME}. Tüm hakları saklıdır.
          </p>
          <p>Veriler Avrupa’da, AWS Stockholm (eu-north-1) bölgesinde saklanır.</p>
        </div>
      </div>
    </footer>
  );
}
