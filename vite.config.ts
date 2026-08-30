import { defineConfig } from 'vite';
import { evidenceBuildIdentity } from './tools/live/buildConfig';

const buildIdentity = evidenceBuildIdentity('static-preview');

export default defineConfig({
  base: '/Aviation-Dashboard-Project/',
  define: {
    __EVIDENCE_BUILD_IDENTITY__: JSON.stringify(buildIdentity),
  },
  plugins: [
    {
      name: 'static-v3-csp',
      transformIndexHtml(html) {
        return html.replace('__LIVE_WEBSOCKET_ORIGIN__', '');
      },
    },
  ],
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
    reportCompressedSize: true,
    rolldownOptions: { input: { index: 'index.html', rollback: 'v2.html' } },
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
