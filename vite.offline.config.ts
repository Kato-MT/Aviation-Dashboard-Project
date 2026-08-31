import { readFile, readdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { evidenceBuildIdentity } from './tools/live/buildConfig';

export const OFFLINE_SOURCE = 'offline.html';
export const OFFLINE_OUTPUT_DIRECTORY = 'dist-offline';
export const OFFLINE_OUTPUT = 'index.html';
export const OFFLINE_AIRSPACE_MAP_IMPORT = './AirspaceMap';
export const OFFLINE_AIRSPACE_MAP_STUB = resolve('src/features/offline/OfflineAirspaceMap.tsx');

export const OFFLINE_FORBIDDEN_RUNTIME_TOKENS = Object.freeze([
  '/api/v1/health',
  '/api/v1/operations',
  '/api/v1/regions',
  '/v2/point/',
  '/map-assets/',
  'pmtiles://',
  'createMapRenderer',
  'maplibre.setWorkerUrl',
  'new WebSocket(',
  '__LIVE_WEBSOCKET_ORIGIN__',
]);

const buildIdentity = evidenceBuildIdentity('offline');

export default defineConfig({
  base: './',
  publicDir: false,
  define: {
    __EVIDENCE_BUILD_IDENTITY__: JSON.stringify(buildIdentity),
  },
  resolve: {
    alias: [
      {
        find: OFFLINE_AIRSPACE_MAP_IMPORT,
        replacement: OFFLINE_AIRSPACE_MAP_STUB,
      },
    ],
  },
  plugins: [
    viteSingleFile(),
    {
      name: 'offline-single-file-contract',
      async closeBundle() {
        const outputDirectory = resolve(OFFLINE_OUTPUT_DIRECTORY);
        await rename(
          resolve(outputDirectory, OFFLINE_SOURCE),
          resolve(outputDirectory, OFFLINE_OUTPUT),
        );
        const inventory = await readdir(outputDirectory);
        if (inventory.length !== 1 || inventory[0] !== OFFLINE_OUTPUT) {
          throw new Error(
            `Offline output must contain only ${OFFLINE_OUTPUT}; found ${inventory.join(', ') || 'nothing'}.`,
          );
        }
        const html = await readFile(resolve(outputDirectory, OFFLINE_OUTPUT), 'utf8');
        if (/<script\b[^>]*\bsrc\s*=/iu.test(html)) {
          throw new Error('Offline output contains a non-inlined script reference.');
        }
        if (/<link\b[^>]*\brel\s*=\s*["']stylesheet["']/iu.test(html)) {
          throw new Error('Offline output contains a non-inlined stylesheet reference.');
        }
        const forbidden = OFFLINE_FORBIDDEN_RUNTIME_TOKENS.filter((token) => html.includes(token));
        if (forbidden.length > 0) {
          throw new Error(
            `Offline output contains forbidden runtime capability: ${forbidden.join(', ')}.`,
          );
        }
      },
    },
  ],
  build: {
    outDir: OFFLINE_OUTPUT_DIRECTORY,
    emptyOutDir: true,
    assetsInlineLimit: Number.POSITIVE_INFINITY,
    cssCodeSplit: false,
    modulePreload: false,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      input: resolve(OFFLINE_SOURCE),
    },
  },
});
