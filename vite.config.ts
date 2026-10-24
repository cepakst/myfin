import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  root: 'src/web',
  base: './',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:5174' },
  },
});
