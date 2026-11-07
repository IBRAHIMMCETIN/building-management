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
});
