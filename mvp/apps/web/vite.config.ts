import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const APP_VERSION = process.env.APP_VERSION ?? 'dev';

/**
 * `version.json` рядом с index.html (Ф11): версия сборки и список её ресурсов. Открытые вкладки узнают о новой
 * версии по нему, а сборка следующей версии по списку `assets` переносит ресурсы этой (предыдущей) версии
 * в новый образ — вкладки старой версии не получают 404 при подгрузке модулей (ops/build-images.sh).
 */
function versionManifest(): Plugin {
  return {
    name: 'cc-version-manifest',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const assets = Object.keys(bundle)
        .filter((f) => f.startsWith('assets/'))
        .sort();
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: `${JSON.stringify({ version: APP_VERSION, builtAt: new Date().toISOString(), assets }, null, 1)}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), versionManifest()],
  // flow-engine — общий с сервером исполнитель сценариев (тестовый прогон в редакторе); берём исходники TS.
  resolve: {
    alias: {
      '@cc/flow-engine': fileURLToPath(new URL('../../packages/flow-engine/src/index.ts', import.meta.url)),
    },
  },
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  server: {
    port: 5173,
    // В разработке API — через Traefik локального стека.
    proxy: { '/api': { target: 'https://localhost', secure: false, changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1500 },
});
