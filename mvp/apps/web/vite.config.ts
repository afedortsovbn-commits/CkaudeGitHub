import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // flow-engine — общий с сервером исполнитель сценариев (тестовый прогон в редакторе); берём исходники TS.
  resolve: {
    alias: {
      '@cc/flow-engine': fileURLToPath(new URL('../../packages/flow-engine/src/index.ts', import.meta.url)),
    },
  },
  define: { __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? 'dev') },
  server: {
    port: 5173,
    // В разработке API — через Traefik локального стека.
    proxy: { '/api': { target: 'https://localhost', secure: false, changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1500 },
});
