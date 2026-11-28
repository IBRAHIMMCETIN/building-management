import {
  BatteryFull,
  ClipboardCheck,
  Clock,
  Copy,
  DoorOpen,
  Ellipsis,
  House,
  ListChecks,
  LogIn,
  type LucideIcon,
  Megaphone,
  Play,
  Plus,
  Receipt,
  Signal,
  UserRound,
  Wrench,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { BrandWordmark } from '@/components/BrandMark';
import { Badge, Card } from '@/components/ui';
import { cn } from '@/lib/cn';
import { MOBILE } from './content';

/*
 * Telefon gorselleri: uygulamanin kendi token'lari ve tip olcegiyle (theme.css; mobil tokens.ts ayni
 * degerler) cizilmis temsili ekranlar. Ekranlar gercek boyutta (320 px) kurulur ve `zoom` ile
 * kucultulur: boylece metin olcegi mobil uygulamadakiyle ayni oranda kalir. Icerik aria-hidden'dir;
 * anlami figcaption tasir. Tutarlar ve kodlar ornektir ve sabittir (on-render HTML'i ile ilk render
 * ayni olmali).
 */

/** Ornek veri etiketi: paylasilan Badge; 12 px'de iki temada da yuksek kontrastli metin rengiyle. */
export function SampleBadge({ className }: { className?: string }) {
  return (
    <Badge tone="neutral" className={cn('text-text-secondary', className)}>
      Örnek veri
    </Badge>
  );
}

/** Gorsellerdeki ornek odeme referans kodu: telefon ve yonetim panelinde ayni vurguyla. */
export const SAMPLE_REFERENCE = 'R4T7KD';

export function ReferenceMark({ className }: { className?: string }) {
  return <mark className={cn('rounded-sm bg-accent/15 px-1 font-mono font-semibold text-text', className)}>{SAMPLE_REFERENCE}</mark>;
}

type Tab = { label: string; icon: LucideIcon };

export const RESIDENT_TABS: readonly Tab[] = [
  { label: 'Ana Sayfa', icon: House },
  { label: 'Borçlarım', icon: Receipt },
  { label: 'Talepler', icon: Wrench },
  { label: 'Duyurular', icon: Megaphone },
  { label: 'Diğer', icon: Ellipsis },
];
const GUARD_TABS: readonly Tab[] = [
  { label: 'Kapı', icon: DoorOpen },
  { label: 'Hesabım', icon: UserRound },
];
const STAFF_TABS: readonly Tab[] = [
  { label: 'İşlerim', icon: ListChecks },
  { label: 'Hesabım', icon: UserRound },
];

const TAB_COLUMNS: Record<number, string> = { 2: 'grid-cols-2', 5: 'grid-cols-5' };

/**
 * Telefon cercevesi: durum cubugu, uygulama ust cubugu (marka + ornek veri), icerik, alt sekmeler.
 * Cihaz kasasi uygulama arayuzu degildir: kose yaricapi (rounded-4xl / 3xl) ve golgesi bilerek temanin
 * kart olceginin (radius sm..xl) disindadir; ekranin icindeki her sey tema token'larini kullanir.
 */
export function PhoneFrame({ tabs, children, className }: { tabs: readonly Tab[]; children: ReactNode; className?: string }) {
  return (
    <div className={cn('w-80 shrink-0 rounded-4xl bg-border-strong p-2 shadow-lg', className)}>
      <div className="flex h-160 flex-col overflow-hidden rounded-3xl bg-bg">
        <div className="relative flex h-8 shrink-0 items-center justify-between bg-surface px-6 text-xs font-semibold text-text">
          <span className="tabular-nums">14:05</span>
          <span className="absolute top-2 left-1/2 h-4 w-16 -translate-x-1/2 rounded-full bg-text" />
          <span className="flex items-center gap-1">
            <Signal className="size-3.5" />
            <BatteryFull className="size-4" />
          </span>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-4 py-3">
          <BrandWordmark className="text-body" />
          <SampleBadge />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-4">{children}</div>
        <div className={cn('grid shrink-0 border-t border-border bg-surface px-2 pt-2 pb-3', TAB_COLUMNS[tabs.length])}>
          {tabs.map(({ label, icon: Icon }, i) => (
            <span key={label} className={cn('flex flex-col items-center gap-1 text-xs font-medium', i === 0 ? 'text-accent' : 'text-muted')}>
              <Icon className="size-5" />
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Ekran icindeki kart: paylasilan Card, telefon olcegindeki ic bosluklarla (mobil Card: 16 pt). */
function ScreenCard({ className, children }: { className?: string; children: ReactNode }) {
  return <Card className={cn('flex flex-col gap-2 p-4 md:p-4', className)}>{children}</Card>;
}

/** Ekran basligi: mobil Screen basligi gibi tema "title" olcegi, kalin. */
function ScreenTitle({ children }: { children: ReactNode }) {
  return <p className="text-title font-bold tracking-tight text-text">{children}</p>;
}

/** Sakin ana sayfasi (web sakin ekrani, telefonda): "Borcunuz", havale bilgileri, "Arıza bildir". */
export function ResidentPortalScreen() {
  return (
    <>
      <ScreenCard>
        <div>
          <p className="text-heading font-semibold text-text">Borcunuz</p>
          <p className="text-small text-muted">A Blok 12</p>
        </div>
        <p className="text-4xl font-bold text-text tabular-nums">₺1.500,50</p>
        <p className="text-small text-muted">
          Son ödeme günü: <strong className="text-text">10.12.2026</strong>
        </p>
      </ScreenCard>
      <ScreenCard className="gap-3">
        <p className="text-small font-semibold text-text">Havale / EFT bilgileri</p>
        <div className="flex items-center justify-between gap-2 rounded-md bg-surface-muted px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs text-text-secondary">IBAN</p>
            <p className="truncate font-mono text-small text-text">TR00 0000 0000 …</p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 text-small font-medium text-accent">
            <Copy className="size-4" />
            Kopyala
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 rounded-md px-3 py-2 ring-2 ring-accent">
          <div className="min-w-0">
            <p className="text-xs text-text-secondary">Ödeme referans kodu</p>
            <p className="text-body">
              <ReferenceMark />
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 text-small font-medium text-accent">
            <Copy className="size-4" />
            Kopyala
          </span>
        </div>
      </ScreenCard>
      <div className="flex items-center justify-center gap-3 rounded-xl bg-primary px-5 py-4 text-lg font-semibold text-on-primary">
        <Wrench className="size-6" />
        Arıza bildir
      </div>
    </>
  );
}

/** Sakin, mobil uygulama ana sayfasi (mobil HomeScreen): guncel borc, ariza / talep. */
function ResidentAppScreen() {
  return (
    <>
      <ScreenTitle>Hoş geldiniz</ScreenTitle>
      <ScreenCard>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-body font-semibold text-text">Güncel borç</p>
            <p className="text-small text-muted">A Blok 12 · Kat maliki</p>
          </div>
          <Badge tone="accent" className="text-text">
            <Clock className="size-3.5" />
            Bekliyor
          </Badge>
        </div>
        <p className="text-title font-bold text-text tabular-nums">₺1.500,50</p>
        <p className="text-small text-muted">
          Kasım aidatı · son ödeme <strong className="text-text">10.12.2026</strong>
        </p>
        <p className="text-small text-muted">Ödemelerinizi apartman yöneticinize elden veya banka havalesiyle yapabilirsiniz.</p>
        <p className="border-t border-border pt-2 text-small font-medium text-accent">Hesap hareketlerim</p>
      </ScreenCard>
      <ScreenCard>
        <p className="flex items-center gap-2 text-body font-semibold text-text">
          <Wrench className="size-5 text-muted" />
          Arıza / Talep
        </p>
        <p className="text-small text-text">
          1 açık talep · <span className="font-medium text-success">1 talep onayınızı bekliyor</span>
        </p>
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-2 text-small font-medium text-text">
            <Plus className="size-4" />
            Arıza bildir
          </span>
          <span className="inline-flex items-center px-3 py-2 text-small font-medium text-accent">Taleplerim</span>
        </div>
      </ScreenCard>
    </>
  );
}

function Chip({ selected, children }: { selected?: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        'flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2.5 text-center text-small font-medium',
        selected ? 'border-accent bg-accent/10 text-text' : 'border-border-strong bg-surface text-text-secondary',
      )}
    >
      {children}
    </span>
  );
}

/** Guvenlik, kapi ekrani (mobil GateScreen, Kurye sekmesi). */
function GuardGateScreen() {
  return (
    <>
      <ScreenTitle>Kapı</ScreenTitle>
      <div className="grid grid-cols-2 gap-2">
        <Chip>Misafir QR / kod</Chip>
        <Chip>Plaka sorgu</Chip>
        <Chip selected>
          Kurye <span className="rounded-full bg-text px-1.5 text-xs text-bg tabular-nums">1</span>
        </Chip>
        <Chip>Kapı kayıtları</Chip>
      </div>
      <ScreenCard>
        <div className="flex items-start justify-between gap-2">
          <p className="text-body font-semibold text-text">C Blok 12</p>
          <Badge tone="success">Onaylandı</Badge>
        </div>
        <p className="text-small text-muted">Kargo, 14:02</p>
        <p className="text-small text-text">Sakin yanıtladı: içeri alınsın.</p>
        <span className="mt-1 flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-body font-semibold text-on-primary">
          <LogIn className="size-5" />
          İçeri al
        </span>
      </ScreenCard>
      <ScreenCard>
        <div className="flex items-start justify-between gap-2">
          <p className="text-body font-semibold text-text">B Blok 7</p>
          <Badge tone="warning" className="text-text">
            Onay bekliyor
          </Badge>
        </div>
        <p className="text-small text-muted">Market siparişi, 14:05</p>
      </ScreenCard>
    </>
  );
}

function WorkItem({ icon: Icon, meta, title, where }: { icon: LucideIcon; meta: string; title: string; where: string }) {
  return (
    <ScreenCard className="flex-row items-start gap-3">
      <Icon className="mt-0.5 size-5 shrink-0 text-accent" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-xs text-muted">{meta}</p>
        <p className="text-body font-medium text-text">{title}</p>
        <p className="text-xs text-muted">{where}</p>
        <span className="mt-1 inline-flex items-center gap-1.5 self-start rounded-md bg-primary px-3 py-1.5 text-small font-medium text-on-primary">
          <Play className="size-4" />
          Başla
        </span>
      </div>
    </ScreenCard>
  );
}

/** Bina gorevlisi, islerim (mobil MyWorkScreen, Bugun sekmesi). */
function StaffWorkScreen() {
  return (
    <>
      <ScreenTitle>İşlerim</ScreenTitle>
      <div className="grid grid-cols-3 gap-2">
        <Chip selected>Bugün 2</Chip>
        <Chip>Bu hafta 5</Chip>
        <Chip>Havuz 1</Chip>
      </div>
      <WorkItem icon={Wrench} meta="Asansör" title="Asansör kapısı geç kapanıyor" where="B Blok, ortak alan" />
      <WorkItem icon={ClipboardCheck} meta="Bakım, 28.11.2026" title="Hidrofor periyodik kontrolü" where="4 kontrol maddesi" />
    </>
  );
}

const ROLE_SCREENS: readonly { tabs: readonly Tab[]; screen: ReactNode; phoneClass: string }[] = [
  { tabs: RESIDENT_TABS, screen: <ResidentAppScreen />, phoneClass: '' },
  // Dar ekranda yalnizca sakin telefonu: diger rollerin aciklamasi gorunur, telefonu gizli.
  { tabs: GUARD_TABS, screen: <GuardGateScreen />, phoneClass: 'hidden sm:block' },
  { tabs: STAFF_TABS, screen: <StaffWorkScreen />, phoneClass: 'hidden sm:block' },
];

/** Mobil bolumu: sakin, guvenlik ve bina gorevlisi ekranlari, her biri kendi aciklamasiyla. */
export function MobileVisual() {
  return (
    <ul className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
      {MOBILE.roles.map((role, i) => {
        const { tabs, screen, phoneClass } = ROLE_SCREENS[i]!;
        return (
          <li key={role.title} className={cn(i === 2 && 'sm:col-span-2 lg:col-span-1')}>
            <figure className="flex flex-col items-center gap-5">
              <div aria-hidden="true" className={phoneClass}>
                <PhoneFrame tabs={tabs} className="[zoom:0.85] sm:[zoom:0.8] lg:[zoom:0.9]">
                  {screen}
                </PhoneFrame>
              </div>
              <figcaption className="max-w-xs text-center">
                <h3 className="text-body font-semibold text-text">{role.title}</h3>
                <p className="mt-1 text-small text-text-secondary">{role.text}</p>
              </figcaption>
            </figure>
          </li>
        );
      })}
    </ul>
  );
}
