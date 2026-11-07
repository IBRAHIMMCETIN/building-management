import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// theme.css'teki ozel yazi boyutlari tanitilmazsa `text-small` renk sanilir ve
// `text-text`/`text-muted` ile cakistirilip silinir.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['small', 'body', 'heading', 'title'],
    },
  },
});

/** Kosullu sinif birlestirme; cakisan Tailwind siniflarinda sonuncusu kazanir. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
