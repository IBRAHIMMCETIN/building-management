import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

/** Uygulamanin (router + oturum) acilisi; `main.tsx` tanitim sayfasi disindaki her durumda yukler. */
export function renderApp(root: HTMLElement) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
