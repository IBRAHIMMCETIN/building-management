import type { LegalDocumentKey } from '@bm/shared/legal/documents';
import { hydrateRoot } from 'react-dom/client';
import { LegalPage } from './LegalPage';

/**
 * On-render edilmis hukuki metin sayfasini (dist/kvkk.html vb., scripts/prerender.mjs) tarayicida
 * etkilesimli yapar; agac sunucudakiyle ayni (`src/prerender.tsx`), uygulama kodu inmez.
 */
export function hydrateLegal(root: HTMLElement, docKey: LegalDocumentKey) {
  hydrateRoot(root, <LegalPage docKey={docKey} />, {
    onRecoverableError: (error) => console.warn('Hukuki metin sayfası hidrasyonu istemcide yeniden çizildi', error),
  });
}
