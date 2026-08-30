import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig, type ResolvedConfig } from 'vite';
import {
  compileLiveBuildRuntimePolicy,
  evidenceBuildIdentity,
  liveBuildOptions,
} from './tools/live/buildConfig';

export const LIVE_CLIENT_INPUTS = { index: 'index.html', live: 'live.html' } as const;
export const LIVE_BUILD_WRAPPER_ENV = 'LIVE_CONNECTED_BUILD_WRAPPER' as const;

export function assertLiveBuildInvocation(
  command: string,
  environment: Readonly<Record<string, string | undefined>>,
  watch = false,
): void {
  if (command !== 'build') return;
  if (environment[LIVE_BUILD_WRAPPER_ENV] !== '1') {
    throw new Error(
      'Connected builds must run through tools/live/buildConnectedArtifact.ts so final whole-tree verification cannot be skipped.',
    );
  }
  if (watch) {
    throw new Error(
      'Connected watch builds are unsupported because every output cycle requires an atomic final whole-tree verification.',
    );
  }
}

function liveTestPort(): number {
  const configured = process.env.LIVE_TEST_PORT ?? '4174';
  if (!/^\d{4,5}$/u.test(configured)) {
    throw new Error('LIVE_TEST_PORT must be a four or five digit loopback port.');
  }
  const port = Number(configured);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('LIVE_TEST_PORT must be between 1024 and 65535.');
  }
  return port;
}

export default defineConfig(async ({ command, mode }) => {
  assertLiveBuildInvocation(command, process.env);
  const options = liveBuildOptions(command, mode);
  const buildIdentity = evidenceBuildIdentity(options.target);
  const port = command === 'serve' ? liveTestPort() : 4174;
  const browserOrigin = `http://127.0.0.1:${port}`;
  const websocketOrigin = `ws://127.0.0.1:${port}`;
  const runtimePolicy = await compileLiveBuildRuntimePolicy(options, buildIdentity, [
    browserOrigin,
  ]);
  const scenario = options.synthetic ? (process.env.LIVE_TEST_SCENARIO ?? 'nominal') : undefined;
  if (!options.synthetic && process.env.LIVE_TEST_SCENARIO !== undefined) {
    throw new Error(
      'Synthetic scenario configuration is forbidden in the public-production build.',
    );
  }
  return {
    base: '/',
    define: {
      __EVIDENCE_BUILD_IDENTITY__: JSON.stringify(buildIdentity),
    },
    plugins: [
      {
        name: 'live-loopback-csp-origin',
        transformIndexHtml(html: string) {
          return html.replace('__LIVE_WEBSOCKET_ORIGIN__', websocketOrigin);
        },
      },
      cloudflare({
        configPath: './wrangler.jsonc',
        viteEnvironment: { name: 'airspace_worker' },
        remoteBindings: false,
        persistState: command === 'serve' ? { path: '.wrangler/live-local' } : false,
        inspectorPort: false,
        tunnel: false,
        config(config) {
          config.name = options.workerName;
          config.main = options.workerMain;
          // Object-form config concatenates arrays, leaving duplicate binding names.
          config.r2_buckets = [
            { binding: 'MAP_ASSETS', bucket_name: `${options.workerName}-maps` },
          ];
          config.vars = {
            ...config.vars,
            LIVE_PROVIDER_MODE: options.providerMode,
            LIVE_BUILD_TARGET: options.target,
            LIVE_PROVIDER_BASE_URL: options.synthetic
              ? 'https://mock-provider.invalid'
              : 'https://api.adsb.lol',
            ALLOWED_ORIGINS: browserOrigin,
            APP_VERSION: buildIdentity.applicationVersion,
            RELEASE_SHA: buildIdentity.releaseSha,
            RUNTIME_POLICY_EPOCH: runtimePolicy.policyEpoch,
            RUNTIME_DEPLOYMENT_CLASS: runtimePolicy.deploymentClass,
            RUNTIME_RELEASE_STATUS: runtimePolicy.release.releaseStatus,
            RUNTIME_PROVIDER_GATE_STATUS: runtimePolicy.providerGate.status,
            RUNTIME_PROVIDER_GATE_VALUE:
              runtimePolicy.providerGate.status === 'closed'
                ? runtimePolicy.providerGate.reason
                : runtimePolicy.providerGate.receiptSha256,
            RUNTIME_POLICY_ID: runtimePolicy.policyId,
          };
          if (command === 'build' || options.mockDevOnly) {
            const runWorkerFirst = config.assets?.run_worker_first;
            if (!config.assets || !Array.isArray(runWorkerFirst)) {
              throw new Error('Connected Live targets require explicit Worker-first routes.');
            }
            config.assets = {
              ...config.assets,
              run_worker_first:
                command === 'build' ? ['/*'] : [...runWorkerFirst, '/__live-test/*'],
            };
          }
          config.services = options.synthetic
            ? [{ binding: 'MOCK_PROVIDER', service: 'flight-airspace-mock-provider' }]
            : [];
        },
        auxiliaryWorkers: options.synthetic
          ? [
              {
                devOnly: options.mockDevOnly,
                viteEnvironment: { name: 'mock_provider' },
                config: {
                  name: 'flight-airspace-mock-provider',
                  main: options.mockMain,
                  compatibility_date: '2026-08-27',
                  vars: { MOCK_SCENARIO: scenario! },
                  observability: {
                    enabled: false,
                    logs: { enabled: false, invocation_logs: false },
                  },
                },
              },
            ]
          : [],
      }),
      {
        name: 'live-reject-watch-builds',
        configResolved(config: ResolvedConfig) {
          assertLiveBuildInvocation(command, process.env, Boolean(config.build.watch));
        },
      },
    ],
    build: { outDir: options.outDir, sourcemap: false, target: 'es2022' },
    environments: {
      client: {
        build: {
          rolldownOptions: {
            input: LIVE_CLIENT_INPUTS,
          },
        },
      },
    },
    server: { host: '127.0.0.1', port, strictPort: true },
    preview: { host: '127.0.0.1', port, strictPort: true },
  };
});
