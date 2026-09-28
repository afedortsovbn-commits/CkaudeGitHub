import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

// Один файл widget.js (IIFE) без внешних зависимостей — встраивается на любой сайт одним тегом <script>.
export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: 'dist',
    lib: { entry: 'src/main.tsx', name: 'CCWidget', formats: ['iife'], fileName: () => 'widget.js' },
    minify: true,
  },
  publicDir: 'public',
});
