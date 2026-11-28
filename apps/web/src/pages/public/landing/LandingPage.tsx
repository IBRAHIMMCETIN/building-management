import { Check, ChevronDown, LogIn } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { ctaClass } from '../cta';
import { PublicFooter } from '../PublicFooter';
import { PublicHeader } from '../PublicHeader';
import { AUDIENCES, CONTACT, FAQS, HERO, MOBILE, MODULE_GROUPS, NAV_LINKS, PRICING, SECTION_IDS, TRUST_ITEMS } from './content';
import { DemoRequestForm } from './DemoRequestForm';
import { HeroVisual } from './HeroVisual';
import { PhoneVisual } from './PhoneVisual';

const CONTAINER = 'mx-auto w-full max-w-page px-4 sm:px-6 lg:px-8';

/** Bolum: sayfa ici baglanti hedefi (yapiskan ust cubugun altinda kalmasin diye scroll-mt-16). */
function Section({ id, className, children }: { id: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-baslik`} className={cn('scroll-mt-16 py-16 lg:py-24', className)}>
      <div className={CONTAINER}>{children}</div>
    </section>
  );
}

function SectionHeading({ id, title, lead }: { id: string; title: string; lead?: string }) {
  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <h2 id={`${id}-baslik`} className="text-title font-bold tracking-tight text-text">
        {title}
      </h2>
      {lead && <p className="text-body text-text-secondary">{lead}</p>}
    </div>
  );
}

function Hero() {
  return (
    <section aria-labelledby="hero-baslik">
      <div className={cn(CONTAINER, 'grid items-center gap-12 py-12 lg:grid-cols-2 lg:gap-16 lg:py-20')}>
        <div className="flex flex-col gap-6">
          <h1 id="hero-baslik" className="text-4xl leading-tight font-extrabold tracking-tight text-text sm:text-5xl sm:leading-tight">
            {HERO.title}
          </h1>
          <p className="max-w-xl text-lg text-text-secondary">{HERO.lead}</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <a href={`#${SECTION_IDS.contact}`} className={ctaClass('primary', 'lg')}>
              Demo talep et
            </a>
            <a href="/login" className={ctaClass('secondary', 'lg')}>
              <LogIn className="size-5" aria-hidden="true" />
              Giriş yap
            </a>
          </div>
          <ul className="flex flex-col gap-2 text-small text-text-secondary">
            {HERO.points.map((p) => (
              <li key={p} className="flex items-start gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <HeroVisual className="lg:p-8" />
      </div>
    </section>
  );
}

function Features() {
  const id = SECTION_IDS.features;
  return (
    <Section id={id} className="border-y border-border bg-surface">
      <SectionHeading
        id={id}
        title="Yönetimin her işi için bir modül"
        lead="Kullanmadığınız modülü sitenizde kapatırsınız; yeniden açtığınızda kayıtlarınız yerinde durur."
      />
      {/* Iki sutun, gruplar sutun icinde bolunmeden dengelenir (gruplarin madde sayisi farkli). */}
      <div className="mt-12 gap-12 md:columns-2">
        {MODULE_GROUPS.map(({ id: groupId, title, icon: Icon, items }) => (
          <div key={groupId} className="mb-10 flex break-inside-avoid flex-col gap-4 last:mb-0">
            <h3 className="flex items-center gap-3 text-heading font-semibold text-text">
              <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent/10 text-accent">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              {title}
            </h3>
            <dl className="flex flex-col divide-y divide-border border-t border-border">
              {items.map((m) => (
                <div key={m.title} className="py-4">
                  <dt className="font-medium text-text">{m.title}</dt>
                  <dd className="mt-1 text-small text-text-secondary">{m.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Audiences() {
  const id = SECTION_IDS.audiences;
  return (
    <Section id={id}>
      <SectionHeading id={id} title="Kimler için" lead="Herkes aynı kayıtlarla çalışır, ama yalnızca kendi işini ve kendi verisini görür." />
      <div className="mt-12 grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-8">
        {AUDIENCES.map(({ title, where, icon: Icon, points }) => (
          <div key={title} className="flex flex-col gap-3 border-t border-border-strong pt-6">
            <Icon className="size-6 text-accent" aria-hidden="true" />
            <div>
              <h3 className="text-body font-semibold text-text">{title}</h3>
              <p className="text-small text-muted">{where}</p>
            </div>
            <ul className="flex flex-col gap-2 text-small text-text-secondary">
              {points.map((p) => (
                <li key={p} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                  {p}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Mobile() {
  const id = SECTION_IDS.mobile;
  return (
    <Section id={id} className="border-y border-border bg-surface">
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Badge tone="accent" className="self-start">
            Yakında App Store ve Google Play’de
          </Badge>
          <SectionHeading id={id} title={MOBILE.title} lead={MOBILE.lead} />
          <dl className="flex flex-col gap-4">
            {MOBILE.roles.map((r) => (
              <div key={r.title}>
                <dt className="font-medium text-text">{r.title}</dt>
                <dd className="mt-1 text-small text-text-secondary">{r.text}</dd>
              </div>
            ))}
          </dl>
          <p className="text-small text-muted">{MOBILE.note}</p>
        </div>
        <PhoneVisual />
      </div>
    </Section>
  );
}

function Trust() {
  const id = SECTION_IDS.trust;
  return (
    <Section id={id}>
      <SectionHeading id={id} title="Güven ve uyum" lead="Muhasebe kayıtlarında değiştirilemezlik, erişimde en az yetki, kişisel veride en az bilgi." />
      <ul className="mt-12 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
        {TRUST_ITEMS.map(({ title, text, icon: Icon }) => (
          <li key={title} className="flex items-start gap-4">
            <span className="grid size-10 shrink-0 place-items-center rounded-md border border-border bg-surface text-accent">
              <Icon className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h3 className="text-body font-semibold text-text">{title}</h3>
              <p className="mt-1 text-small text-text-secondary">{text}</p>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function FaqSection() {
  const id = SECTION_IDS.faq;
  return (
    <Section id={id} className="border-y border-border bg-surface">
      <div className="grid gap-10 lg:grid-cols-3">
        <div className="flex flex-col gap-4">
          <SectionHeading id={id} title="Sık sorulan sorular" />
          <p className="text-small text-text-secondary">
            Sorunuz burada yoksa{' '}
            <a href={`#${SECTION_IDS.contact}`} className="font-medium text-accent underline-offset-4 hover:underline">
              demo formundan yazın
            </a>
            .
          </p>
        </div>
        <div className="border-t border-border lg:col-span-2">
          {FAQS.map((f) => (
            <details key={f.question} className="group border-b border-border">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-md py-4 text-body font-medium text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
                {f.question}
                <ChevronDown className="size-5 shrink-0 text-muted group-open:rotate-180 motion-safe:transition-transform" aria-hidden="true" />
              </summary>
              <p className="pb-5 text-small text-text-secondary">{f.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}

function Pricing() {
  const id = SECTION_IDS.pricing;
  return (
    <section id={id} aria-labelledby={`${id}-baslik`} className="scroll-mt-16 pt-16 lg:pt-24">
      <div className={CONTAINER}>
        <div className="flex flex-col gap-6 rounded-xl border border-border bg-surface p-6 shadow-sm md:p-8 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex max-w-2xl flex-col gap-2">
            <h2 id={`${id}-baslik`} className="text-title font-bold tracking-tight text-text">
              Fiyatlandırma
            </h2>
            <p className="text-lg font-medium text-text">{PRICING.title}</p>
            <p className="text-small text-text-secondary">{PRICING.text}</p>
          </div>
          <a href={`#${SECTION_IDS.contact}`} className={ctaClass('primary', 'lg', 'shrink-0')}>
            Teklif alın
          </a>
        </div>
      </div>
    </section>
  );
}

function Contact() {
  const id = SECTION_IDS.contact;
  return (
    <Section id={id}>
      <div className="grid gap-10 lg:grid-cols-5">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <SectionHeading id={id} title={CONTACT.title} lead={CONTACT.lead} />
          <ol className="flex flex-col gap-4">
            {CONTACT.steps.map((s, i) => (
              <li key={s} className="flex items-start gap-3 text-small text-text-secondary">
                <span className="grid size-7 shrink-0 place-items-center rounded-full border border-border-strong text-xs font-semibold text-text tabular-nums">
                  {i + 1}
                </span>
                <span className="pt-1">{s}</span>
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted">Formdaki bilgiler yalnızca bu talebe dönüş için kullanılır ve 2 yıl sonra silinir.</p>
        </div>
        <div className="lg:col-span-3">
          <DemoRequestForm />
        </div>
      </div>
    </Section>
  );
}

/**
 * Herkese acik tanitim sayfasi (`/`, oturumu olmayan ziyaretci). Router'a bagli degildir (duz
 * baglantilar): derleme sonunda statik HTML'e on-render edilir (scripts/prerender.mjs) ve tarayicida
 * yalnizca bu agac hidrate edilir; uygulama kodu indirilmez.
 */
export function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <a
        href="#ana-icerik"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-small focus:font-medium focus:shadow-md focus:outline-2 focus:outline-accent"
      >
        İçeriğe geç
      </a>
      <PublicHeader links={NAV_LINKS} />
      <main id="ana-icerik" tabIndex={-1} className="flex-1 focus:outline-none">
        <Hero />
        <Features />
        <Audiences />
        <Mobile />
        <Trust />
        <FaqSection />
        <Pricing />
        <Contact />
      </main>
      <PublicFooter />
    </div>
  );
}
