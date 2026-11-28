/*
 * Mobil tema: web'in tek tema kaynaginin (apps/web/src/styles/theme.css) birebir karsiligi.
 * Bilesenler ham renk/olcu yazmaz; yalnizca bu token'lari kullanir. Marka: lacivert #122a4e,
 * turkuaz #00aeb4, turuncu #fc7200 (metin tonlari AA icin koyulastirilmis; kontrastlar theme.css'te).
 */

export type Palette = {
  bg: string;
  surface: string;
  surfaceMuted: string;
  text: string;
  textSecondary: string;
  muted: string;
  border: string;
  borderStrong: string;
  accent: string;
  accentHover: string;
  primary: string;
  primaryHover: string;
  brandInk: string;
  brandOrange: string;
  onPrimary: string;
  onAccent: string;
  success: string;
  warning: string;
  danger: string;
  scrim: string;
};

export const palettes: Record<'light' | 'dark', Palette> = {
  light: {
    bg: '#fafafa',
    surface: '#ffffff',
    surfaceMuted: '#f4f4f5',
    text: '#18181b',
    textSecondary: '#3f3f46',
    muted: '#71717a',
    border: '#e4e4e7',
    borderStrong: '#d4d4d8',
    accent: '#007a80',
    accentHover: '#00646a',
    primary: '#122a4e',
    primaryHover: '#1c3a66',
    brandInk: '#122a4e',
    brandOrange: '#d95f00',
    onPrimary: '#ffffff',
    onAccent: '#ffffff',
    success: '#047857',
    warning: '#b45309',
    danger: '#dc2626',
    scrim: 'rgba(9, 9, 11, 0.5)',
  },
  dark: {
    bg: '#09090b',
    surface: '#18181b',
    surfaceMuted: '#27272a',
    text: '#f4f4f5',
    textSecondary: '#d4d4d8',
    muted: '#a1a1aa',
    border: '#27272a',
    borderStrong: '#3f3f46',
    accent: '#3fd0d6',
    accentHover: '#6bdde1',
    primary: '#2ec4cb',
    primaryHover: '#5fd6db',
    brandInk: '#f4f4f5',
    brandOrange: '#fc7200',
    onPrimary: '#09090b',
    onAccent: '#09090b',
    success: '#34d399',
    warning: '#fbbf24',
    danger: '#f87171',
    scrim: 'rgba(0, 0, 0, 0.65)',
  },
};

/** theme.css --radius-* (rem -> pt: 1rem = 16). */
export const radii = { sm: 6, md: 8, lg: 12, xl: 14, full: 999 } as const;

/** theme.css --text-* (boyut / satir yuksekligi carpani). */
export const typeScale = {
  small: { fontSize: 14, lineHeight: 20 },
  body: { fontSize: 16, lineHeight: 24 },
  heading: { fontSize: 20, lineHeight: 26 },
  title: { fontSize: 32, lineHeight: 38 },
  caption: { fontSize: 12, lineHeight: 16 },
} as const;

/** Tailwind bosluk tabani (4 pt): space(4) = 16. */
export const space = (n: number) => n * 4;

/** Erisilebilir en kucuk dokunma alani (Apple HIG 44 pt; Android 48 dp onerisi). */
export const MIN_TOUCH = 44;

/**
 * Genis ekranda (iPad / tablet) icerik genisligi: telefon ekranlari tablette uzayip satirlar okunmaz
 * hale gelmesin diye ortalanmis en fazla 720 pt (web `max-w-3xl` karsiligi). Kapı masasi gibi iki
 * sutunlu saha ekranlari 960 pt'ye kadar.
 */
export const CONTENT_MAX_WIDTH = 720;
export const WIDE_CONTENT_MAX_WIDTH = 960;

/** "#rrggbb" + saydamlik -> "rgba(...)" (web'deki `bg-success/10` karsiligi). */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h as string, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
