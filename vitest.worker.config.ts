import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { compileRuntimePolicy } from './src/live/runtimePolicy';

const workerTestPolicy = await compileRuntimePolicy({
  target: 'live-staging',
  providerMode: 'live',
  providerBaseUrl: 'https://api.adsb.lol',
  mockBindingPresent: false,
  allowedOrigins: ['http://127.0.0.1:4173', 'http://localhost:4173'],
  deploymentClass: 'loopback',
  release: {
    applicationVersion: '3.0.0-dev',
    releaseSha: 'local-unreleased',
    releaseStatus: 'unreleased',
    buildTarget: 'live-staging',
  },
  policyEpoch: 'r3-local-1',
  providerGate: { status: 'approved', receiptSha256: 'b'.repeat(64) },
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          LIVE_PROVIDER_MODE: 'live',
          LIVE_BUILD_TARGET: 'live-staging',
          RUNTIME_POLICY_EPOCH: workerTestPolicy.policyEpoch,
          RUNTIME_DEPLOYMENT_CLASS: workerTestPolicy.deploymentClass,
          RUNTIME_RELEASE_STATUS: workerTestPolicy.release.releaseStatus,
          RUNTIME_PROVIDER_GATE_STATUS: workerTestPolicy.providerGate.status,
          RUNTIME_PROVIDER_GATE_VALUE:
            workerTestPolicy.providerGate.status === 'approved'
              ? workerTestPolicy.providerGate.receiptSha256
              : workerTestPolicy.providerGate.reason,
          RUNTIME_POLICY_ID: workerTestPolicy.policyId,
        },
        outboundService: () => {
          throw new Error('Unmocked external requests are forbidden in Worker tests.');
        },
      },
    }),
  ],
  test: {
    include: ['tests/worker/**/*.test.ts'],
    reporters: ['default'],
  },
});
