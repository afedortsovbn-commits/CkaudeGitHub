import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? 'dev') },
  server: {
    port: 5173,
    // В разработке API — через Traefik локального стека.
    proxy: { '/api': { target: 'https://localhost', secure: false, changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1500 },
});
