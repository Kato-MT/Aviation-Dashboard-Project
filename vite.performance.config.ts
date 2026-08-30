import { resolve } from 'node:path';

import { defineConfig } from 'vite';

const repositoryRoot = resolve(import.meta.dirname);

if (process.env.NODE_ENV !== 'production') {
  throw new Error('The optimized browser performance client requires NODE_ENV=production.');
}
if (Object.keys(process.env).some((key) => /^VITE_/iu.test(key))) {
  throw new Error('The optimized browser performance client rejects inherited VITE variables.');
}

export const PERFORMANCE_CLIENT_OUTDIR = resolve(repositoryRoot, '.tmp-tests/performance-client');

export default defineConfig({
  base: '/',
  envDir: false,
  build: {
    outDir: PERFORMANCE_CLIENT_OUTDIR,
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    minify: true,
    rollupOptions: {
      input: {
        performance: resolve(repositoryRoot, 'tests/live-browser/performance-harness.html'),
      },
    },
  },
});
