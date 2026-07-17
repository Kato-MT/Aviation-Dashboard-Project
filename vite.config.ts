import { defineConfig } from 'vite';

export default defineConfig({
  base: '/Aviation-Dashboard-Project/',
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    reportCompressedSize: true,
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
});
