import { Check, ChevronDown, Smartphone } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { ctaClass } from '../cta';
import { PublicFooter } from '../PublicFooter';
import { PublicHeader, SkipLink } from '../PublicHeader';
import { AUDIENCES, CONTACT, FAQS, HERO, MOBILE, MODULE_GROUPS, NAV_LINKS, PILOT, SECTION_IDS, STEPS, TRUST } from './content';
import { DemoRequestForm } from './DemoRequestForm';
import { HeroVisual } from './HeroVisual';
import { MobileVisual } from './PhoneVisual';

const CONTAINER = 'mx-auto w-full max-w-page px-4 sm:px-6 lg:px-8';
const CONTACT_HREF = `#${SECTION_IDS.contact}`;

/** Bolum: sayfa ici baglanti hedefi (yapiskan ust cubugun altinda kalmasin diye scroll-mt-16). */
function Section({ id, className, children }: { id: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-baslik`} className={cn('scroll-mt-16 py-16 lg:py-24', className)}>
      <div className={CONTAINER}>{children}</div>
    </section>
  );
}

function SectionHeading({ id, title, lead, className }: { id: string; title: string; lead?: string; className?: string }) {
  return (
    <div className={cn('flex max-w-2xl flex-col gap-3', className)}>
      <h2 id={`${id}-baslik`} className="text-title font-bold tracking-tight text-text">
        {title}
      </h2>
      {lead && <p className="text-body text-text-secondary">{lead}</p>}
    </div>
  );
}

function CheckList({ items, className, iconClass = 'text-accent' }: { items: readonly string[]; className?: string; iconClass?: string }) {
  return (
    <ul className={cn('flex flex-col gap-2', className)}>
      {items.map((p) => (
        <li key={p} className="flex items-start gap-2">
          <Check className={cn('mt-0.5 size-4 shrink-0', iconClass)} aria-hidden="true" />
          {p}
        </li>
      ))}
    </ul>
  );
}

function Hero() {
  return (
    <section aria-labelledby="hero-baslik">
      <div className={cn(CONTAINER, 'grid items-center gap-12 py-12 lg:py-20 xl:grid-cols-12')}>
        <div className="flex flex-col gap-6 xl:col-span-5">
          <a
            href={`#${SECTION_IDS.pilot}`}
            className="inline-flex items-center gap-2 self-start rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-small font-medium text-text hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span className="size-2 rounded-full bg-accent" aria-hidden="true" />
            {HERO.offer}
          </a>
          <h1 id="hero-baslik" className="text-4xl leading-tight font-extrabold tracking-tight text-balance text-text sm:text-5xl sm:leading-tight">
            {HERO.title}
          </h1>
          <p className="max-w-xl text-lg text-text-secondary">{HERO.lead}</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <a href={CONTACT_HREF} className={ctaClass('primary', 'lg')}>
              Demo talep et
            </a>
            <a href={`#${SECTION_IDS.how}`} className={ctaClass('secondary', 'lg')}>
              Nasıl çalışır?
            </a>
          </div>
          <CheckList items={HERO.points} className="text-small text-text-secondary" />
        </div>
        <HeroVisual className="xl:col-span-7" />
      </div>
    </section>
  );
}

function HowItWorks() {
  const id = SECTION_IDS.how;
  return (
    <Section id={id} className="border-y border-border bg-surface">
      <SectionHeading id={id} title="Nasıl çalışır" lead="Kurulumdan ilk rapora dört adım. Pilot dönemde kurulumu sizinle birlikte yaparız." />
      <ol className="mt-14 grid gap-x-6 gap-y-12 md:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <li key={s.title} className="relative flex flex-col gap-2 border-t-2 border-border-strong pt-8">
            <span className="absolute -top-4 left-0 grid size-8 place-items-center rounded-full bg-primary text-small font-bold text-on-primary tabular-nums">
              {i + 1}
            </span>
            <h3 className="text-heading font-semibold text-text">{s.title}</h3>
            <p className="text-small text-text-secondary">{s.text}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Audiences() {
  const id = SECTION_IDS.audiences;
  return (
    <Section id={id}>
      <SectionHeading id={id} title="Kimler için" lead="Özellikle 200’den fazla bağımsız bölümü olan, birden çok bloklu siteler için hazırlandı." />
      <div className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
        {AUDIENCES.map(({ title, icon: Icon, points }) => (
          <div key={title} className="flex flex-col gap-4 border-t border-border-strong pt-6">
            <span className="grid size-10 place-items-center rounded-md bg-accent/10 text-accent">
              <Icon className="size-5" aria-hidden="true" />
            </span>
            <h3 className="text-heading font-semibold text-text">{title}</h3>
            <CheckList items={points} className="text-small text-text-secondary" />
          </div>
        ))}
      </div>
    </Section>
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
      {/* Sutunlar, gruplar bolunmeden dengelenir (gruplarin madde sayisi farkli). */}
      <div className="mt-12 gap-10 md:columns-2 lg:columns-3">
        {MODULE_GROUPS.map(({ id: groupId, title, icon: Icon, items }) => (
          <div key={groupId} className="mb-10 flex break-inside-avoid flex-col gap-3 last:mb-0">
            <h3 className="flex items-center gap-3 text-heading font-semibold text-text">
              <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent/10 text-accent">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              {title}
            </h3>
            <dl className="flex flex-col divide-y divide-border border-t border-border">
              {items.map((m) => (
                <div key={m.title} className="py-3">
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

function Mobile() {
  const id = SECTION_IDS.mobile;
  return (
    <Section id={id}>
      <div className="grid gap-8 lg:grid-cols-12 lg:items-end">
        <SectionHeading id={id} title={MOBILE.title} lead={MOBILE.lead} className="lg:col-span-7" />
        <div className="flex flex-col gap-3 lg:col-span-5">
          <p className="text-heading font-semibold text-text">{MOBILE.status}</p>
          <ul className="flex flex-wrap gap-2">
            {MOBILE.stores.map((store) => (
              <li key={store} className="inline-flex items-center gap-2 rounded-lg border border-border-strong bg-surface px-4 py-2.5">
                <Smartphone className="size-5 text-muted" aria-hidden="true" />
                <span className="font-semibold text-text">{store}</span>
                <span className="text-small text-muted">yakında</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="mt-14">
        <MobileVisual />
      </div>
    </Section>
  );
}

function Trust() {
  const id = SECTION_IDS.trust;
  return (
    <Section id={id} className="border-y border-border bg-surface">
      <div className="grid gap-12 lg:grid-cols-12">
        <div className="flex flex-col gap-6 lg:col-span-5">
          <SectionHeading id={id} title={TRUST.title} />
          <div className="flex flex-col gap-3 border-l-4 border-accent pl-5">
            <p className="text-2xl font-bold tracking-tight text-text">{TRUST.promise}</p>
            <p className="text-body text-text-secondary">{TRUST.promiseText}</p>
          </div>
        </div>
        <ul className="grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:col-span-7">
          {TRUST.items.map(({ title, text, icon: Icon }) => (
            <li key={title} className="flex items-start gap-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-md border border-border bg-bg text-accent">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-body font-semibold text-text">{title}</h3>
                <p className="mt-1 text-small text-text-secondary">{text}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

function Pilot() {
  const id = SECTION_IDS.pilot;
  return (
    <section id={id} aria-labelledby={`${id}-baslik`} className="scroll-mt-16 bg-primary text-on-primary">
      <div className={cn(CONTAINER, 'grid gap-10 py-16 lg:grid-cols-12 lg:items-center lg:py-24')}>
        <div className="flex flex-col gap-5 lg:col-span-7">
          <h2 id={`${id}-baslik`} className="text-title font-bold tracking-tight">
            {PILOT.title}
          </h2>
          <p className="max-w-2xl text-lg">{PILOT.lead}</p>
          <CheckList items={PILOT.points} iconClass="text-on-primary" />
        </div>
        <div className="flex flex-col gap-3 lg:col-span-5 lg:items-start">
          <a href={CONTACT_HREF} className={ctaClass('inverse', 'lg')}>
            Demo talep et
          </a>
          <p className="max-w-sm text-small">{PILOT.note}</p>
        </div>
      </div>
    </section>
  );
}

function FaqSection() {
  const id = SECTION_IDS.faq;
  return (
    <Section id={id} className="border-b border-border bg-surface">
      <div className="grid gap-10 lg:grid-cols-3">
        <div className="flex flex-col gap-4">
          <SectionHeading id={id} title="Sık sorulan sorular" />
          <p className="text-small text-text-secondary">
            Sorunuz burada yoksa{' '}
            <a
              href={CONTACT_HREF}
              className="rounded-sm font-medium text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
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
              <p className="max-w-prose pb-5 text-small text-text-secondary">{f.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </Section>
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
      <SkipLink />
      <PublicHeader links={NAV_LINKS} />
      <main id="ana-icerik" tabIndex={-1} className="flex-1 focus:outline-none">
        <Hero />
        <HowItWorks />
        <Audiences />
        <Features />
        <Mobile />
        <Trust />
        <Pilot />
        <FaqSection />
        <Contact />
      </main>
      <PublicFooter links={NAV_LINKS} />
    </div>
  );
}
