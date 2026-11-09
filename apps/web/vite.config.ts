/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Proje kokune gore: '@/lib/api' -> '<apps/web>/src/lib/api'
    alias: { '@': '/src' },
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
});
