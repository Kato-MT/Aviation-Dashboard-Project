import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { lstat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import mapManifest from '../../maps/manifest.json';
import rollbackManifest from '../../rollback/v2.2.0/manifest.json';
import {
  compileRuntimePolicy,
  runtimePolicyCanonicalJson,
  type RuntimePolicyInput,
  type RuntimePolicyV1,
} from '../../src/live/runtimePolicy';
import {
  LIVE_APPLICATION_VERSION,
  LIVE_RUNTIME_DEPLOYMENT_CLASS,
  LIVE_RUNTIME_DISABLE_REASON,
  LIVE_RUNTIME_POLICY_EPOCH,
} from './buildConfig';

export type ConnectedBuildTarget = 'production' | 'mock-staging';
export type GeneratedWorkerKind = 'airspace-worker' | 'mock-provider';

type JsonRecord = Record<string, unknown>;

const AIRSPACE_WORKER_KEYS = [
  'name',
  'main',
  'compatibility_date',
  'compatibility_flags',
  'rules',
  'assets',
  'limits',
  'vars',
  'durable_objects',
  'migrations',
  'r2_buckets',
  'services',
  'observability',
  'no_bundle',
] as const;

const MOCK_PROVIDER_KEYS = [
  'name',
  'main',
  'compatibility_date',
  'compatibility_flags',
  'rules',
  'vars',
  'services',
  'observability',
  'no_bundle',
] as const;

const FORBIDDEN_METADATA_KEY =
  /^(?:configpath|userconfigpath|workspaceroot|repositoryroot|projectroot|sourceroot|sourcescontent)$/u;
const CREDENTIAL_KEY =
  /^(?:password|passwd|secret|token|apikey|apitoken|authtoken|bearertoken|authorization|cookie|privatekey|accesskey|accesskeyid|secretkey|secretaccesskey|sessiontoken|awsaccesskeyid|awssecretaccesskey|awssessiontoken|accesstoken|refreshtoken|idtoken|clientsecret|githubtoken|cloudflaretoken)$/u;
const WINDOWS_PATH = /(?:^|[\s"'`=:,(/])(?:[a-z]:\/)[^\s"'`,)}\]]+/iu;
const WINDOWS_DEVICE_PATH =
  /(?:^|[\s"'`=,(])\/\/[?.]\/(?:UNC\/)?(?:[a-z]:\/|[A-Za-z0-9._$-]{1,64}\/)/iu;
const WINDOWS_VOLUME_PATH = /(?:^|[\s"'`=,(])\/\/[?.]\/Volume\{[0-9a-f-]{36}\}\//iu;
const WINDOWS_UNC_PATH =
  /(?:^|[\s"'`=,(])\/\/[A-Za-z0-9._$-]{1,64}\/[A-Za-z0-9._$ -]{1,128}(?:\/|$)/u;
const WRAPPED_UNC_PATH =
  /\b(?:webpack|vite|rollup|rspack):\/{4,}[A-Za-z0-9._$-]{1,64}\/[A-Za-z0-9._$ -]{1,128}(?:\/|$)/iu;
const POSIX_PRIVATE_PATH =
  /(?:^|[^A-Za-z0-9_~%./-]|\.\.)\/+(?:Users\/[A-Za-z0-9._-]+|home\/[A-Za-z0-9._-]+|root(?:\/|$)|tmp(?:\/|$)|private\/tmp(?:\/|$)|var\/tmp(?:\/|$)|var\/lib\/(?:jenkins\/workspace|buildkite-agent\/builds|gitlab-runner\/builds)(?:\/|$)|srv\/(?:build|ci|jenkins|runner|workspace)(?:\/|$)|github\/workspace(?:\/|$)|__w(?:\/|$)|Volumes\/(?:build|runner|workspace)(?:\/|$)|mnt\/[a-z]\/Users\/[A-Za-z0-9._-]+|usr\/src\/(?:app|workspace)(?:\/|$)|drone\/src(?:\/|$)|go\/src(?:\/|$)|vercel\/path0(?:\/|$)|workspace(?:s)?(?:\/|$)|opt\/(?:build|runner|workspace|app)(?:\/|$)|builds(?:\/|$))/iu;
const CREDENTIAL_URL_PARAMETER =
  /[?#&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|secret|client[_-]?secret|password|passwd|signature|x-amz-[a-z0-9-]+|x-goog-[a-z0-9-]+)(?:\[\])?=[^&#\s"'`]+/iu;
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/iu;
const CREDENTIAL_USERINFO = /(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s"'`/@]+@[^\s"'`/]+/iu;
const CREDENTIAL_LITERAL =
  /["'`]?(?:token|secret|github[_-]?token|cloudflare[_-]?token|api[_-]?(?:key|token)|auth[_-]?token|bearer[_-]?token|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|session[_-]?token|password|passwd|authorization|cookie)["'`]?\s*[:=]\s*["'`][^\r\n"'`]{1,2048}["'`]/iu;
const STANDALONE_CREDENTIAL =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/u;
const AUTHORIZATION_CREDENTIAL = /\b(?:Proxy-)?Authorization\s*:\s*[^\r\n"'`]{1,2048}/iu;
const COOKIE_CREDENTIAL = /\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n"'`]{1,2048}/iu;
const SOURCE_MAP_REFERENCE = /sourceMappingURL\s*=/iu;
const COMPRESSED_SOURCE_MAP_FILE = /\.map\.(?:br|gz)$/iu;
const RAW_SOURCE_MAP_FILE = /\.map$/iu;
const EXPECTED_PRIVATE_SOURCE_MAP =
  /^(?:client\/assets\/.+\.(?:css|js)|airspace_worker\/index\.js|mock_provider\/index\.js)\.map$/iu;
const MAX_SOURCE_MAP_SOURCES = 4_096;
const TEXT_ARTIFACT = /\.(?:c?js|mjs|css|html?|json|svg|txt|xml|md|sha256)$/iu;
const CLIENT_ASSET = /^client\/assets\/.+\.(?:css|js)$/iu;
const CLIENT_FONT = /^client\/assets\/(inter-latin-(?:400|600)-normal)-[A-Za-z0-9_-]+\.(woff2?)$/u;
const FIXED_DEPLOYABLE_FILES = new Set([
  'airspace_worker/.vite/manifest.json',
  'airspace_worker/index.js',
  'airspace_worker/wrangler.json',
  'client/.assetsignore',
  'client/_headers',
  'client/_redirects',
  'client/index.html',
  'client/live.html',
  'client/runtime-policy.json',
  'mock_provider/index.js',
  'mock_provider/wrangler.json',
]);
const EXPECTED_ASSETSIGNORE = 'wrangler.json\n.dev.vars\n';
const EXPECTED_REDIRECTS =
  '/ /index.html 200\n/Aviation-Dashboard-Project/ /Aviation-Dashboard-Project/index.html 200\n';

type ApprovedIdentity = Readonly<{ bytes: number; sha256: string; kind: 'map' | 'rollback' }>;

const APPROVED_RETAINED_IDENTITIES = new Map<string, ApprovedIdentity>();
for (const asset of mapManifest.assets) {
  APPROVED_RETAINED_IDENTITIES.set(`map_assets/${mapManifest.id}/${asset.path}`, {
    bytes: asset.bytes,
    sha256: asset.sha256,
    kind: 'map',
  });
}

const APPROVED_CLIENT_FONT_SOURCES = new Map<string, string>([
  [
    'inter-latin-400-normal.woff',
    fileURLToPath(
      new URL(
        '../../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff',
        import.meta.url,
      ),
    ),
  ],
  [
    'inter-latin-400-normal.woff2',
    fileURLToPath(
      new URL(
        '../../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2',
        import.meta.url,
      ),
    ),
  ],
  [
    'inter-latin-600-normal.woff',
    fileURLToPath(
      new URL(
        '../../node_modules/@fontsource/inter/files/inter-latin-600-normal.woff',
        import.meta.url,
      ),
    ),
  ],
  [
    'inter-latin-600-normal.woff2',
    fileURLToPath(
      new URL(
        '../../node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2',
        import.meta.url,
      ),
    ),
  ],
]);
for (const file of rollbackManifest.runtimeFiles) {
  APPROVED_RETAINED_IDENTITIES.set(`client/Aviation-Dashboard-Project/${file.path}`, {
    bytes: file.bytes,
    sha256: file.sha256,
    kind: 'rollback',
  });
  if (file.path === rollbackManifest.runtimePolicy.entryPath) {
    APPROVED_RETAINED_IDENTITIES.set('client/v2.html', {
      bytes: file.bytes,
      sha256: file.sha256,
      kind: 'rollback',
    });
  }
}

const PRODUCTION_FORBIDDEN_TOKENS = [
  'tests/support/mockProvider',
  'SYNTHETIC_OUTAGE',
  'MOCK_SCENARIO',
  'MOCK_REQUEST_REJECTED',
  'flight-airspace-mock-provider',
  'NATIVE_EGRESS_BLOCKED',
  'guardedAirspaceWorker',
  'guardedMockProvider',
  'denyNativeEgress',
] as const;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as JsonRecord;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertAllowedKeys(value: JsonRecord, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `${label} contains forbidden deployment fields: ${unexpected.sort().join(', ')}.`,
    );
  }
}

function assertExactJson(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} is outside the closed generated deployment policy.`);
  }
}

function assertGeneratedWorkerPolicy(
  document: JsonRecord,
  kind: GeneratedWorkerKind,
  target: ConnectedBuildTarget,
): void {
  const moduleRules = [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }];
  const observability = {
    enabled: false,
    logs: { enabled: false, invocation_logs: false },
  };
  if (kind === 'mock-provider') {
    if (target !== 'mock-staging') {
      throw new Error('A generated mock provider is forbidden outside mock staging.');
    }
    assertExactJson(
      document,
      {
        name: 'flight-airspace-mock-provider',
        main: 'index.js',
        compatibility_date: '2026-08-27',
        compatibility_flags: [],
        rules: moduleRules,
        vars: { MOCK_SCENARIO: 'nominal' },
        services: [],
        observability,
        no_bundle: true,
      },
      'Generated mock-provider deployment document',
    );
    return;
  }
  const vars = record(document.vars, 'Generated airspace Worker vars');
  const releaseSha = vars.RELEASE_SHA;
  const policyId = vars.RUNTIME_POLICY_ID;
  if (
    typeof releaseSha !== 'string' ||
    (releaseSha !== 'local-unreleased' && !/^[a-f0-9]{40}$/u.test(releaseSha))
  ) {
    throw new Error('Generated airspace Worker release SHA is outside the closed policy.');
  }
  if (typeof policyId !== 'string' || !/^[a-f0-9]{64}$/u.test(policyId)) {
    throw new Error('Generated airspace Worker policy ID is outside the closed policy.');
  }
  assertExactJson(
    document,
    {
      name: `flight-airspace-${target}`,
      main: 'index.js',
      compatibility_date: '2026-08-27',
      compatibility_flags: [],
      rules: moduleRules,
      assets: {
        directory: '../client',
        binding: 'ASSETS',
        html_handling: 'none',
        not_found_handling: 'none',
        run_worker_first: ['/*'],
      },
      limits: { cpu_ms: 10, subrequests: 10 },
      vars: {
        LIVE_PROVIDER_MODE: target === 'mock-staging' ? 'mock' : 'disabled',
        LIVE_BUILD_TARGET: target,
        LIVE_PROVIDER_BASE_URL:
          target === 'mock-staging' ? 'https://mock-provider.invalid' : 'https://api.adsb.lol',
        ALLOWED_ORIGINS: 'http://127.0.0.1:4174',
        APP_VERSION: LIVE_APPLICATION_VERSION,
        RELEASE_SHA: releaseSha,
        RUNTIME_POLICY_EPOCH: LIVE_RUNTIME_POLICY_EPOCH,
        RUNTIME_DEPLOYMENT_CLASS: LIVE_RUNTIME_DEPLOYMENT_CLASS,
        RUNTIME_RELEASE_STATUS: 'unreleased',
        RUNTIME_PROVIDER_GATE_STATUS: 'closed',
        RUNTIME_PROVIDER_GATE_VALUE: LIVE_RUNTIME_DISABLE_REASON,
        RUNTIME_POLICY_ID: policyId,
      },
      durable_objects: {
        bindings: [{ name: 'REGION_FEEDS', class_name: 'RegionalFeedHub' }],
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['RegionalFeedHub'] }],
      r2_buckets: [{ binding: 'MAP_ASSETS', bucket_name: `flight-airspace-${target}-maps` }],
      services:
        target === 'mock-staging'
          ? [{ binding: 'MOCK_PROVIDER', service: 'flight-airspace-mock-provider' }]
          : [],
      observability,
      no_bundle: true,
    },
    'Generated airspace Worker deployment document',
  );
}

function generatedRuntimePolicyInput(
  document: JsonRecord,
  target: ConnectedBuildTarget,
): Readonly<RuntimePolicyInput> {
  const vars = record(document.vars, 'Generated airspace Worker vars');
  const origins = vars.ALLOWED_ORIGINS;
  if (typeof origins !== 'string') {
    throw new Error('Generated airspace Worker origins are outside the runtime policy.');
  }
  return {
    target,
    providerMode: target === 'mock-staging' ? 'mock' : 'disabled',
    providerBaseUrl:
      target === 'mock-staging' ? 'https://mock-provider.invalid' : 'https://api.adsb.lol',
    mockBindingPresent: target === 'mock-staging',
    allowedOrigins: origins.split(','),
    deploymentClass: LIVE_RUNTIME_DEPLOYMENT_CLASS,
    release: {
      applicationVersion: vars.APP_VERSION as string,
      releaseSha: vars.RELEASE_SHA as string,
      releaseStatus: vars.RUNTIME_RELEASE_STATUS as 'unreleased',
      buildTarget: target,
    },
    policyEpoch: vars.RUNTIME_POLICY_EPOCH as string,
    providerGate: {
      status: 'closed',
      reason: vars.RUNTIME_PROVIDER_GATE_VALUE as typeof LIVE_RUNTIME_DISABLE_REASON,
    },
  };
}

export async function compileGeneratedRuntimePolicy(
  workerConfiguration: unknown,
  target: ConnectedBuildTarget,
): Promise<Readonly<RuntimePolicyV1>> {
  const document = record(workerConfiguration, 'Generated airspace Worker configuration');
  assertAllowedKeys(document, AIRSPACE_WORKER_KEYS, 'Generated airspace Worker configuration');
  assertGeneratedWorkerPolicy(document, 'airspace-worker', target);
  const policy = await compileRuntimePolicy(generatedRuntimePolicyInput(document, target));
  const vars = record(document.vars, 'Generated airspace Worker vars');
  if (vars.RUNTIME_POLICY_ID !== policy.policyId) {
    throw new Error('Generated airspace Worker policy ID does not match the compiled policy.');
  }
  return policy;
}

function selectedFields(value: JsonRecord, keys: readonly string[]): JsonRecord {
  return Object.fromEntries(
    keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]),
  );
}

export function sanitizeGeneratedWrangler(
  value: unknown,
  kind: GeneratedWorkerKind,
): Readonly<JsonRecord> {
  const document = record(value, 'Generated Wrangler configuration');
  const keys = kind === 'airspace-worker' ? AIRSPACE_WORKER_KEYS : MOCK_PROVIDER_KEYS;
  const sanitized = selectedFields(document, keys);
  assertAllowedKeys(sanitized, keys, 'Sanitized Wrangler configuration');
  return Object.freeze(sanitized);
}

function decodePercentEscapes(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function decodeJavaScriptEscapes(value: string): string {
  return value
    .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (_match, digits: string) => {
      const point = Number.parseInt(digits, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : _match;
    })
    .replace(/\\u([0-9a-f]{4})/giu, (_match, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 16)),
    )
    .replace(/\\x([0-9a-f]{2})/giu, (_match, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 16)),
    );
}

const HTML_ENTITY_CHARACTERS: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  apos: "'",
  bsol: '\\',
  colon: ':',
  equals: '=',
  num: '#',
  quot: '"',
  sol: '/',
});

function decodeHtmlEntities(value: string): string {
  return value
    .replace(
      /&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));?/giu,
      (match, hexadecimal: string | undefined, decimal: string | undefined) => {
        const point = Number.parseInt(hexadecimal ?? decimal ?? '', hexadecimal ? 16 : 10);
        return Number.isSafeInteger(point) && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : match;
      },
    )
    .replace(/&(amp|apos|bsol|colon|equals|num|quot|sol);/giu, (match, name: string) => {
      return HTML_ENTITY_CHARACTERS[name.toLowerCase()] ?? match;
    });
}

function decodeCssEscapes(value: string): string {
  return value
    .replace(/\\(?:\r\n|[\n\r\f])/gu, '')
    .replace(/\\([0-9a-f]{1,6})(?:\r\n|[\t\n\f\r ])?/giu, (match, digits: string) => {
      const point = Number.parseInt(digits, 16);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/\\([!"#$%&'()*+,./:;<=>?@[\]^_`{|}~-])/gu, '$1');
}

function unsafeStringVariant(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  const normalizedPath = normalized.replace(/\/{2,}/gu, '/');
  return (
    WINDOWS_PATH.test(normalizedPath) ||
    WINDOWS_DEVICE_PATH.test(normalized) ||
    WINDOWS_VOLUME_PATH.test(normalized) ||
    WINDOWS_UNC_PATH.test(normalized) ||
    WRAPPED_UNC_PATH.test(normalized) ||
    POSIX_PRIVATE_PATH.test(normalizedPath) ||
    containsUnsafeUrlReference(normalized) ||
    CREDENTIAL_USERINFO.test(normalized.replace(/[\t\r\n]/gu, '')) ||
    CREDENTIAL_URL_PARAMETER.test(normalized) ||
    BEARER_CREDENTIAL.test(normalized) ||
    CREDENTIAL_LITERAL.test(normalized) ||
    STANDALONE_CREDENTIAL.test(normalized) ||
    AUTHORIZATION_CREDENTIAL.test(normalized) ||
    COOKIE_CREDENTIAL.test(normalized)
  );
}

function containsUnsafeUrlReference(value: string): boolean {
  const normalizedValue = value.replace(/[\t\r\n]/gu, '');
  const candidates = normalizedValue.matchAll(
    /(?<![a-z0-9+.-])(?:file:[^\s"'`<>(){}]*|(?:[a-z][a-z0-9+.-]*:\/{1,}|\/\/)[^\s"'`<>(){}]+)/giu,
  );
  for (const match of candidates) {
    const candidate = match[0];
    if (/^file:/iu.test(candidate)) {
      if (/^file:\/*$/iu.test(candidate)) continue;
      const preceding = match.index > 0 ? normalizedValue[match.index - 1] : undefined;
      if (preceding === '^' && /^file:\/\.test$/iu.test(candidate)) continue;
      return true;
    }
    try {
      const parsed = new URL(candidate.startsWith('//') ? `https:${candidate}` : candidate);
      if (parsed.username !== '' || parsed.password !== '') return true;
    } catch {
      continue;
    }
  }
  return false;
}

function assertSafeString(value: string, label: string): void {
  const variants = new Set<string>([value]);
  let current = value;
  for (let pass = 0; pass < 4; pass += 1) {
    current = decodeJavaScriptEscapes(
      decodeCssEscapes(decodeHtmlEntities(decodePercentEscapes(current))),
    );
    variants.add(current);
  }
  const residual = decodeJavaScriptEscapes(
    decodeCssEscapes(decodeHtmlEntities(decodePercentEscapes(current))),
  );
  if (residual !== current) {
    throw new Error(`${label} contains over-encoded forbidden artifact text.`);
  }
  if ([...variants].some(unsafeStringVariant)) {
    throw new Error(
      `${label} contains a forbidden local path, file URL, or credential-bearing URL.`,
    );
  }
}

function inspectJson(value: unknown, label: string): void {
  if (typeof value === 'string') {
    assertSafeString(value, label);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectJson(entry, `${label}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, entry] of Object.entries(value as JsonRecord)) {
    const normalizedKey = key
      .normalize('NFKC')
      .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
      .replace(/[^a-z0-9]/giu, '')
      .toLowerCase();
    if (normalizedKey === 'sourceroot' && entry === '') {
      continue;
    }
    if (FORBIDDEN_METADATA_KEY.test(normalizedKey)) {
      throw new Error(`${label} contains forbidden deployment metadata key ${key}.`);
    }
    if (
      CREDENTIAL_KEY.test(normalizedKey) &&
      entry !== '' &&
      entry !== undefined &&
      entry !== null
    ) {
      throw new Error(`${label} contains credential-shaped field ${key}.`);
    }
    inspectJson(entry, `${label}.${key}`);
  }
}

function assertRelativeSourceMapEntries(value: unknown, label: string): void {
  const sources =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as JsonRecord).sources
      : undefined;
  if (!Array.isArray(sources) || sources.length > MAX_SOURCE_MAP_SOURCES) {
    throw new Error(`${label} must contain a bounded relative sources array.`);
  }
  for (const source of sources) {
    if (typeof source !== 'string' || source.length < 1 || source.length > 512) {
      throw new Error(`${label} must contain only bounded relative source paths.`);
    }
    let decoded = source;
    for (let pass = 0; pass < 4; pass += 1) {
      decoded = decodeJavaScriptEscapes(
        decodeCssEscapes(decodeHtmlEntities(decodePercentEscapes(decoded))),
      );
    }
    const normalized = decoded.replaceAll('\\', '/');
    if (
      normalized.startsWith('/') ||
      /^[a-z]:\//iu.test(normalized) ||
      /^[a-z][a-z0-9+.-]*:/iu.test(normalized) ||
      normalized.includes('\0')
    ) {
      throw new Error(`${label} must contain only bounded relative source paths.`);
    }
  }
}

function assertNoDuplicateJsonKeys(text: string, label: string): void {
  let cursor = 0;
  let nodes = 0;
  const invalid = (): never => {
    throw new Error(`${label} is not valid duplicate-free JSON.`);
  };
  const whitespace = (): void => {
    while (cursor < text.length && /[\t\n\r ]/u.test(text[cursor]!)) cursor += 1;
  };
  const string = (): string => {
    if (text[cursor] !== '"') invalid();
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      const character = text[cursor]!;
      if (character === '"') {
        cursor += 1;
        try {
          return JSON.parse(text.slice(start, cursor)) as string;
        } catch {
          invalid();
        }
      }
      if (character === '\\') {
        cursor += 2;
        continue;
      }
      if (character.codePointAt(0)! < 0x20) invalid();
      cursor += 1;
    }
    return invalid();
  };
  const value = (depth: number): void => {
    nodes += 1;
    if (depth > 128 || nodes > 100_000) invalid();
    whitespace();
    if (text[cursor] === '{') {
      object(depth + 1);
      return;
    }
    if (text[cursor] === '[') {
      array(depth + 1);
      return;
    }
    if (text[cursor] === '"') {
      string();
      return;
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
      text.slice(cursor),
    )?.[0];
    cursor += (token ?? invalid()).length;
  };
  const object = (depth: number): void => {
    cursor += 1;
    whitespace();
    if (text[cursor] === '}') {
      cursor += 1;
      return;
    }
    const keys = new Set<string>();
    while (cursor < text.length) {
      whitespace();
      const key = string();
      if (keys.has(key)) {
        throw new Error(`${label} contains duplicate JSON field ${key}.`);
      }
      keys.add(key);
      whitespace();
      if (text[cursor] !== ':') invalid();
      cursor += 1;
      value(depth);
      whitespace();
      if (text[cursor] === '}') {
        cursor += 1;
        return;
      }
      if (text[cursor] !== ',') invalid();
      cursor += 1;
    }
    invalid();
  };
  const array = (depth: number): void => {
    cursor += 1;
    whitespace();
    if (text[cursor] === ']') {
      cursor += 1;
      return;
    }
    while (cursor < text.length) {
      value(depth);
      whitespace();
      if (text[cursor] === ']') {
        cursor += 1;
        return;
      }
      if (text[cursor] !== ',') invalid();
      cursor += 1;
    }
    invalid();
  };
  value(0);
  whitespace();
  if (cursor !== text.length) invalid();
}

export function assertPrivacySafeTextArtifact(value: string, label: string): void {
  if (/\.(?:json|map)$/iu.test(label)) assertNoDuplicateJsonKeys(value, label);
  assertSafeString(value, label);
  if (!/\.(?:json|map)$/iu.test(label)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (/\.map$/iu.test(label)) assertRelativeSourceMapEntries(parsed, label);
  inspectJson(parsed, label);
}

function assertAllowedDeployablePath(
  path: string,
  target: ConnectedBuildTarget,
  approvedClientFont: boolean,
): void {
  const fixed = FIXED_DEPLOYABLE_FILES.has(path);
  const mockOnly = path.startsWith('mock_provider/');
  if (
    (fixed && (!mockOnly || target === 'mock-staging')) ||
    CLIENT_ASSET.test(path) ||
    approvedClientFont ||
    APPROVED_RETAINED_IDENTITIES.has(path)
  ) {
    return;
  }
  throw new Error(`Connected artifact contains an undeclared deployable file role: ${path}.`);
}

function isTextArtifact(path: string): boolean {
  return (
    TEXT_ARTIFACT.test(path) ||
    path === 'client/.assetsignore' ||
    path === 'client/_headers' ||
    path === 'client/_redirects'
  );
}

const FORBIDDEN_TEXT_BOMS = [
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from([0xff, 0xfe, 0x00, 0x00]),
  Buffer.from([0x00, 0x00, 0xfe, 0xff]),
  Buffer.from([0xff, 0xfe]),
  Buffer.from([0xfe, 0xff]),
  Buffer.from([0x2b, 0x2f, 0x76]),
] as const;

async function readStrictUtf8Artifact(path: string, label: string): Promise<string> {
  const bytes = await readFile(path);
  if (
    bytes.includes(0) ||
    FORBIDDEN_TEXT_BOMS.some(
      (bom) => bytes.length >= bom.length && bytes.subarray(0, bom.length).equals(bom),
    )
  ) {
    throw new Error(`${label} is not strict BOM-free UTF-8 text.`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not strict BOM-free UTF-8 text.`);
  }
}

export function renderRuntimePolicyMetaCsp(policy: Readonly<RuntimePolicyV1>): string {
  const connectSources = ["'self'", ...policy.origins.websocket].join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connectSources}`,
    "worker-src 'self' blob: data:",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

function parseMetaAttributes(tag: string, label: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  const body = tag.replace(/^<meta\b/iu, '').replace(/>$/u, '');
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of body.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (!name || attributes.has(name)) {
      throw new Error(`${label} contains an ambiguous meta element.`);
    }
    attributes.set(name, decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return attributes;
}

function assertBuiltMetaCsp(html: string, label: string, policy: Readonly<RuntimePolicyV1>): void {
  const tags = html.match(/<meta\b[^>]*>/giu) ?? [];
  const cspMetas = tags
    .map((tag) => parseMetaAttributes(tag, label))
    .filter(
      (attributes) => attributes.get('http-equiv')?.toLowerCase() === 'content-security-policy',
    );
  if (cspMetas.length !== 1) {
    throw new Error(`${label} must contain exactly one Content-Security-Policy meta element.`);
  }
  const cspMeta = cspMetas[0];
  if (cspMeta === undefined) {
    throw new Error(`${label} must contain exactly one Content-Security-Policy meta element.`);
  }
  const content = cspMeta.get('content');
  if (content !== renderRuntimePolicyMetaCsp(policy)) {
    throw new Error(`${label} meta Content-Security-Policy is missing or mismatched.`);
  }
}

async function filesIn(directory: string): Promise<string[]> {
  const rootMetadata = await lstat(directory);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(
      `Connected artifact contains a non-directory or symbolic-link node: ${directory}`,
    );
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Connected artifact contains a symbolic link: ${path}`);
      }
      if (metadata.isDirectory()) return filesIn(path);
      if (!metadata.isFile()) {
        throw new Error(`Connected artifact contains a non-regular filesystem node: ${path}`);
      }
      return [path];
    }),
  );
  return nested.flat().sort((left, right) => left.localeCompare(right));
}

async function fileSha256(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest('hex');
}

async function assertApprovedRetainedIdentity(
  path: string,
  artifactPath: string,
): Promise<boolean> {
  const expected = APPROVED_RETAINED_IDENTITIES.get(artifactPath);
  if (!expected) return false;
  const metadata = await lstat(path);
  if (metadata.size !== expected.bytes || (await fileSha256(path)) !== expected.sha256) {
    throw new Error(
      `Connected artifact ${expected.kind} bytes do not match the approved identity: ${artifactPath}.`,
    );
  }
  return true;
}

async function approvedClientFontRole(
  path: string,
  artifactPath: string,
): Promise<string | undefined> {
  const match = CLIENT_FONT.exec(artifactPath);
  if (!match) return undefined;
  const role = `${match[1]}.${match[2]}`;
  const sourcePath = APPROVED_CLIENT_FONT_SOURCES.get(role);
  if (!sourcePath) {
    throw new Error(`Connected artifact contains an undeclared client font role: ${artifactPath}.`);
  }
  const [artifactMetadata, sourceMetadata, artifactSha256, sourceSha256] = await Promise.all([
    lstat(path),
    lstat(sourcePath),
    fileSha256(path),
    fileSha256(sourcePath),
  ]);
  if (artifactMetadata.size !== sourceMetadata.size || artifactSha256 !== sourceSha256) {
    throw new Error(
      `Connected artifact client font bytes do not match the pinned dependency identity: ${artifactPath}.`,
    );
  }
  return role;
}

function wranglerKind(path: string): GeneratedWorkerKind | undefined {
  const normalized = path.replaceAll('\\', '/');
  if (normalized === 'airspace_worker/wrangler.json') return 'airspace-worker';
  if (normalized === 'mock_provider/wrangler.json') return 'mock-provider';
  return undefined;
}

export async function assertLiveArtifactPolicy(
  artifactRoot: string,
  target: ConnectedBuildTarget,
  options: Readonly<{ allowSourceMaps?: boolean }> = {},
): Promise<void> {
  const files = await filesIn(artifactRoot);
  const artifactPaths = files.map((path) => relative(artifactRoot, path).replaceAll('\\', '/'));
  const mockFiles = artifactPaths.filter((path) => path.startsWith('mock_provider/'));
  if (target === 'production' && mockFiles.length > 0) {
    throw new Error('Production connected artifact contains a mock-provider capability.');
  }
  if (
    target === 'mock-staging' &&
    (!artifactPaths.includes('mock_provider/index.js') ||
      !artifactPaths.includes('mock_provider/wrangler.json'))
  ) {
    throw new Error('Mock-staging connected artifact is missing its isolated mock provider.');
  }
  const workerConfigurationText = await readStrictUtf8Artifact(
    join(artifactRoot, 'airspace_worker', 'wrangler.json'),
    'airspace_worker/wrangler.json',
  );
  assertPrivacySafeTextArtifact(workerConfigurationText, 'airspace_worker/wrangler.json');
  const workerConfiguration = JSON.parse(workerConfigurationText) as unknown;
  const compiledPolicy = await compileGeneratedRuntimePolicy(workerConfiguration, target);
  const policyManifest = JSON.parse(
    await readStrictUtf8Artifact(
      join(artifactRoot, 'client', 'runtime-policy.json'),
      'client/runtime-policy.json',
    ),
  ) as unknown;
  assertExactJson(policyManifest, compiledPolicy, 'Generated runtime-policy manifest');
  const staticHeaders = await readStrictUtf8Artifact(
    join(artifactRoot, 'client', '_headers'),
    'client/_headers',
  );
  if (staticHeaders !== renderRuntimePolicyHeaders(compiledPolicy)) {
    throw new Error('Connected artifact static response-header policy is missing or mismatched.');
  }
  const assetsIgnore = await readStrictUtf8Artifact(
    join(artifactRoot, 'client', '.assetsignore'),
    'client/.assetsignore',
  );
  if (assetsIgnore !== EXPECTED_ASSETSIGNORE) {
    throw new Error('Connected artifact asset exclusion policy is missing or mismatched.');
  }
  const redirects = await readStrictUtf8Artifact(
    join(artifactRoot, 'client', '_redirects'),
    'client/_redirects',
  );
  if (redirects !== EXPECTED_REDIRECTS) {
    throw new Error('Connected artifact redirect policy is missing or mismatched.');
  }
  for (const name of ['index.html', 'live.html'] as const) {
    const artifactPath = `client/${name}`;
    const html = await readStrictUtf8Artifact(join(artifactRoot, 'client', name), artifactPath);
    assertBuiltMetaCsp(html, artifactPath, compiledPolicy);
  }
  if (!options.allowSourceMaps && files.some((path) => path.toLowerCase().endsWith('.map'))) {
    throw new Error('Connected artifact contains a publicly retrievable source map.');
  }
  const seenClientFontRoles = new Set<string>();
  for (const path of files) {
    const artifactPath = relative(artifactRoot, path).replaceAll('\\', '/');
    assertSafeString(artifactPath, 'Connected artifact path');
    for (const segment of artifactPath.split('/')) {
      assertSafeString(segment, 'Connected artifact path segment');
    }
    const clientFontRole = await approvedClientFontRole(path, artifactPath);
    if (clientFontRole) {
      if (seenClientFontRoles.has(clientFontRole)) {
        throw new Error(
          `Connected artifact duplicates a pinned client font role: ${clientFontRole}.`,
        );
      }
      seenClientFontRoles.add(clientFontRole);
    }
    const rawSourceMap = RAW_SOURCE_MAP_FILE.test(artifactPath);
    if (COMPRESSED_SOURCE_MAP_FILE.test(artifactPath)) {
      throw new Error(
        `Connected artifact contains a public source-map representation: ${artifactPath}.`,
      );
    }
    if (rawSourceMap) {
      if (!options.allowSourceMaps || !EXPECTED_PRIVATE_SOURCE_MAP.test(artifactPath)) {
        throw new Error(
          `Connected artifact contains a public source-map representation: ${artifactPath}.`,
        );
      }
    } else {
      assertAllowedDeployablePath(artifactPath, target, clientFontRole !== undefined);
    }
    if (await assertApprovedRetainedIdentity(path, artifactPath)) continue;
    if (clientFontRole) continue;
    if (!rawSourceMap && !isTextArtifact(artifactPath)) continue;
    const text = await readStrictUtf8Artifact(path, artifactPath);
    try {
      assertPrivacySafeTextArtifact(text, artifactPath);
    } catch {
      throw new Error(`${artifactPath} contains a forbidden path or source-map reference.`);
    }
    if (!options.allowSourceMaps && SOURCE_MAP_REFERENCE.test(text)) {
      throw new Error(`${artifactPath} contains a forbidden path or source-map reference.`);
    }
    const kind = wranglerKind(artifactPath);
    if (kind) {
      const parsed = JSON.parse(text) as unknown;
      const document = record(parsed, artifactPath);
      assertAllowedKeys(
        document,
        kind === 'airspace-worker' ? AIRSPACE_WORKER_KEYS : MOCK_PROVIDER_KEYS,
        artifactPath,
      );
      assertGeneratedWorkerPolicy(document, kind, target);
      inspectJson(document, artifactPath);
    }
    if (target === 'production') {
      const forbidden = PRODUCTION_FORBIDDEN_TOKENS.find((token) => text.includes(token));
      if (forbidden)
        throw new Error(`${artifactPath} contains production-forbidden token ${forbidden}.`);
    }
  }
}

function websocketOrigins(allowedOrigins: unknown): string[] {
  if (typeof allowedOrigins !== 'string') {
    throw new Error('Generated Worker ALLOWED_ORIGINS must be a string.');
  }
  const origins = allowedOrigins
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (origins.length === 0 || new Set(origins).size !== origins.length) {
    throw new Error('Generated Worker ALLOWED_ORIGINS must be nonempty and duplicate-free.');
  }
  return origins.map((origin) => {
    const url = new URL(origin);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.origin !== origin
    ) {
      throw new Error(`Generated Worker origin is not canonical: ${origin}`);
    }
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.origin;
  });
}

export function renderConnectedHeaders(workerConfiguration: unknown): string {
  const worker = record(workerConfiguration, 'Generated Worker configuration');
  const vars = record(worker.vars, 'Generated Worker vars');
  const websocketSources = websocketOrigins(vars.ALLOWED_ORIGINS);
  const loopbackRollbackSource = websocketSources.some((origin) => {
    const hostname = new URL(origin).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  })
    ? ['ws://127.0.0.1:*']
    : [];
  const connectSources = ["'self'", ...websocketSources, ...loopbackRollbackSource].join(' ');
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connectSources}`,
    "worker-src 'self' blob: data:",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return [
    '/*',
    `  Content-Security-Policy: ${csp}`,
    '  X-Frame-Options: DENY',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '  Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    '  Cross-Origin-Opener-Policy: same-origin',
    '  Cross-Origin-Resource-Policy: same-origin',
    '',
  ].join('\n');
}

export function renderRuntimePolicyHeaders(policy: Readonly<RuntimePolicyV1>): string {
  const headers = policy.headers.static;
  return [
    '/*',
    `  Content-Security-Policy: ${headers['content-security-policy']}`,
    `  X-Frame-Options: ${headers['x-frame-options']}`,
    `  X-Content-Type-Options: ${headers['x-content-type-options']}`,
    `  Referrer-Policy: ${headers['referrer-policy']}`,
    `  Permissions-Policy: ${headers['permissions-policy']}`,
    `  Cross-Origin-Opener-Policy: ${headers['cross-origin-opener-policy']}`,
    `  Cross-Origin-Resource-Policy: ${headers['cross-origin-resource-policy']}`,
    '',
  ].join('\n');
}

async function sanitizeWranglerFile(path: string, kind: GeneratedWorkerKind): Promise<JsonRecord> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const sanitized = sanitizeGeneratedWrangler(parsed, kind) as JsonRecord;
  await writeFile(path, canonicalJson(sanitized), 'utf8');
  return sanitized;
}

export async function finalizeLiveBuildArtifact(
  artifactRoot: string,
  target: ConnectedBuildTarget,
  expectedPolicy?: Readonly<RuntimePolicyV1>,
): Promise<void> {
  const worker = await sanitizeWranglerFile(
    join(artifactRoot, 'airspace_worker', 'wrangler.json'),
    'airspace-worker',
  );
  if (target === 'mock-staging') {
    await sanitizeWranglerFile(
      join(artifactRoot, 'mock_provider', 'wrangler.json'),
      'mock-provider',
    );
  }
  const compiledPolicy = await compileGeneratedRuntimePolicy(worker, target);
  if (
    expectedPolicy !== undefined &&
    runtimePolicyCanonicalJson(expectedPolicy) !== runtimePolicyCanonicalJson(compiledPolicy)
  ) {
    throw new Error('Generated deployment policy differs from the build-selected runtime policy.');
  }
  await writeFile(
    join(artifactRoot, 'client', 'runtime-policy.json'),
    canonicalJson(compiledPolicy),
    'utf8',
  );
  await writeFile(
    join(artifactRoot, 'client', '_headers'),
    renderRuntimePolicyHeaders(compiledPolicy),
    'utf8',
  );
  await assertLiveArtifactPolicy(artifactRoot, target);
}

export async function liveBuildArtifactReady(
  artifactRoot: string,
  target: ConnectedBuildTarget,
): Promise<boolean> {
  const required = [
    join(artifactRoot, 'airspace_worker', 'wrangler.json'),
    join(artifactRoot, 'airspace_worker', 'index.js'),
    join(artifactRoot, 'client', 'index.html'),
    join(artifactRoot, 'client', 'live.html'),
    join(artifactRoot, 'client', 'assets'),
    ...(target === 'mock-staging'
      ? [
          join(artifactRoot, 'mock_provider', 'wrangler.json'),
          join(artifactRoot, 'mock_provider', 'index.js'),
        ]
      : []),
  ];
  try {
    await Promise.all(required.map((path) => access(path)));
    return true;
  } catch {
    return false;
  }
}
