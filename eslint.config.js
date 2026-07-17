import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const browserGlobals = {
  Blob: 'readonly',
  Crypto: 'readonly',
  CustomEvent: 'readonly',
  Document: 'readonly',
  Element: 'readonly',
  Event: 'readonly',
  File: 'readonly',
  FileReader: 'readonly',
  HTMLButtonElement: 'readonly',
  HTMLCanvasElement: 'readonly',
  HTMLElement: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLSelectElement: 'readonly',
  MouseEvent: 'readonly',
  URL: 'readonly',
  WebSocket: 'readonly',
  crypto: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  performance: 'readonly',
  requestAnimationFrame: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  window: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '.git/**',
      '.pnpm-store/**',
      '.tmp-tests/**',
      'dist/**',
      'dist-offline/**',
      'coverage/**',
      'node_modules/**',
      'playwright-report/**',
      'release/**',
      'test-results/**',
      'models/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { globals: browserGlobals },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['simulator/**/*.ts', 'tools/**/*.ts', '*.config.ts'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
);
