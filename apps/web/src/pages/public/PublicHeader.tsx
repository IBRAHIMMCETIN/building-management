import { LogIn, Menu, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { BrandMark, BrandWordmark } from '@/components/BrandMark';
import { BRAND_NAME } from '@/lib/brand';
import { cn } from '@/lib/cn';
import { ctaClass, textLinkClass } from './cta';

type NavLink = { href: string; label: string };

/** "İçeriğe geç": klavyeyle ilk odaklanan oge; `main#ana-icerik`'e atlar. */
export function SkipLink() {
  return (
    <a
      href="#ana-icerik"
      className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-small focus:font-medium focus:shadow-sm focus:outline-2 focus:outline-accent"
    >
      İçeriğe geç
    </a>
  );
}

/**
 * Tanitim ve hukuki sayfalarin ust cubugu: logo (ana sayfaya), sayfa ici baglantilar, "Giriş yap"
 * ve "Demo talep et". Dar ekranda baglantilar menu dugmesiyle acilan panelde (aria-expanded);
 * baglantiya tiklayinca veya Escape ile kapanir. Baglantilar duz <a>: sayfa router disinda da
 * (on-render edilmis tanitim sayfasi) calisir.
 */
export function PublicHeader({ links = [], demoHref = '#iletisim', homeHref = '/' }: { links?: readonly NavLink[]; demoHref?: string; homeHref?: string }) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const hasLinks = links.length > 0;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Odak gizlenecek paneldeyse menu dugmesine doner; baska yerdeyse (ornegin formda) yerinde kalir.
      const inPanel = document.getElementById('public-menu')?.contains(document.activeElement) ?? false;
      setOpen(false);
      if (inPanel) toggleRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/90 backdrop-blur-sm">
      <div className="mx-auto flex h-16 w-full max-w-page items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <a
          href={homeHref}
          aria-label={`${BRAND_NAME} ana sayfa`}
          className="flex items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <BrandMark small className="size-8" />
          <BrandWordmark className="text-heading" />
        </a>

        {hasLinks && (
          <nav aria-label="Sayfa bölümleri" className="hidden lg:block">
            <ul className="flex items-center gap-6 text-small font-medium">
              {links.map((l) => (
                <li key={l.href}>
                  <a href={l.href} className={textLinkClass}>
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <div className="hidden items-center gap-2 sm:flex">
          <a href="/login" className={ctaClass('secondary')}>
            <LogIn className="size-4" aria-hidden="true" />
            Giriş yap
          </a>
          <a href={demoHref} className={ctaClass('primary')}>
            Demo talep et
          </a>
        </div>

        <button
          ref={toggleRef}
          type="button"
          className={cn(
            'inline-flex size-10 items-center justify-center rounded-md text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
            hasLinks ? 'lg:hidden' : 'sm:hidden',
          )}
          aria-expanded={open}
          aria-controls="public-menu"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X className="size-5" aria-hidden="true" /> : <Menu className="size-5" aria-hidden="true" />}
          <span className="sr-only">{open ? 'Menüyü kapat' : 'Menüyü aç'}</span>
        </button>
      </div>

      <div id="public-menu" hidden={!open} className={cn('border-t border-border bg-bg', hasLinks ? 'lg:hidden' : 'sm:hidden')}>
        <nav aria-label="Menü" className="mx-auto flex w-full max-w-page flex-col gap-1 px-4 py-4 sm:px-6">
          {links.map((l) => (
            <a key={l.href} href={l.href} onClick={() => setOpen(false)} className="rounded-md px-3 py-2.5 text-body font-medium text-text hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-accent">
              {l.label}
            </a>
          ))}
          <div className="mt-3 flex flex-col gap-2 border-t border-border pt-4 sm:hidden">
            <a href={demoHref} onClick={() => setOpen(false)} className={ctaClass('primary', 'md', 'w-full')}>
              Demo talep et
            </a>
            <a href="/login" className={ctaClass('secondary', 'md', 'w-full')}>
              <LogIn className="size-4" aria-hidden="true" />
              Giriş yap
            </a>
          </div>
        </nav>
      </div>
    </header>
  );
}
