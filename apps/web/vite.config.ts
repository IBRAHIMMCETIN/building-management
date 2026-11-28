/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';

/**
 * Uygulama acilis parcalari (src/appRoot.tsx ve statik bagimliliklari) index.html'deki satir ici
 * acilis betigine yazilir (`'__APP_PRELOAD__'`): betik uygulama acilacaksa bunlari `modulepreload` ile
 * hemen ister (main -> appRoot zincirinde ek bir gidis-donus beklenmez); tanitim sayfasinda istemez.
 */
function appPreload(): Plugin {
  return {
    name: 'bm-app-preload',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return html;
        const entry = Object.values(bundle).find(
          (c) => c.type === 'chunk' && (c.facadeModuleId ?? '').replace(/\\/g, '/').endsWith('/src/appRoot.tsx'),
        );
        const files = new Set<string>();
        const visit = (name: string) => {
          const chunk = bundle[name];
          if (files.has(name) || !chunk || chunk.type !== 'chunk') return;
          files.add(name);
          chunk.imports.forEach(visit);
        };
        if (entry) visit(entry.fileName);
        return html.replace("'__APP_PRELOAD__'", JSON.stringify([...files].map((f) => `/${f}`)));
      },
    },
  };
}

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react(), tailwindcss(), appPreload()],
  resolve: {
    // Proje kokune gore: '@/lib/api' -> '<apps/web>/src/lib/api'
    alias: { '@': '/src' },
  },
  // Tanitim sayfasi on-render derlemesi (`vite build --ssr src/prerender.tsx`, bkz. scripts/prerender.mjs):
  // calisma alani paketi (TS kaynak) pakete gomulur; diger bagimliliklar Node'dan yuklenir.
  ssr: { noExternal: ['@bm/shared'] },
  build: {
    // On-render derlemesi yalnizca gecici bir JS modulu uretir; public/ kopyalanmaz.
    copyPublicDir: !isSsrBuild,
    rolldownOptions: {
      output: {
        // Sayfalar router'da React.lazy ile ayri parcalardir. Uzun omurlu kutuphaneler (sik
        // degismeyen) ayri vendor parcalarina alinir: uygulama kodu degisince tarayici onbellegi
        // korunur. Excel / QR kutuphaneleri zaten dinamik import ile yalnizca ilgili ekranda iner.
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/, priority: 30 },
            { name: 'vendor-auth', test: /node_modules[\\/](aws-amplify|@aws-amplify|@aws-crypto|@aws-sdk|@smithy)[\\/]/, priority: 20 },
            { name: 'vendor-data', test: /node_modules[\\/](@tanstack|zod)[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
  server: {
    // VITE_API_URL bos birakilirsa istekler goreli gider ve buradan yerel API'ye aktarilir.
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    // Testler her ortamda (CI dahil, .env.local olmadan) ayni yapilandirmayla kosar:
    // mock kimlik, goreli API adresi. Gercek Cognito/AWS'ye hicbir test baglanmaz.
    env: {
      VITE_AUTH_MODE: 'mock',
      VITE_API_URL: '',
      VITE_COGNITO_REGION: 'eu-north-1',
      VITE_COGNITO_USER_POOL_ID: 'test-pool',
      VITE_COGNITO_USER_POOL_CLIENT: 'test-client',
      VITE_COGNITO_TOKEN_USE: 'id',
    },
  },
}));
