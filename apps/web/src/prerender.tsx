import { renderToString } from 'react-dom/server';
import { LandingPage } from './pages/public/landing/LandingPage';

/**
 * Derleme sonu on-render girisi (`vite build --ssr src/prerender.tsx`, ardindan
 * scripts/prerender.mjs): tanitim sayfasi statik HTML olarak dist/index.html'deki #root'a yazilir.
 * Tarayicida ayni agac `pages/public/landing/island.tsx` ile hidrate edilir.
 */
export function render(): string {
  return renderToString(<LandingPage />);
}
