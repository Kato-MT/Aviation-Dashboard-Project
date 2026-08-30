import { gzipSync } from 'node:zlib';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImportType, init as initializeModuleLexer, parse as parseModule } from 'es-module-lexer';
import { parse as parseHtml, type DefaultTreeAdapterTypes } from 'parse5';
import ts from 'typescript';

import { RUNTIME_POLICY_LIMITS } from '../../src/live/runtimePolicyLimits';
import {
  captureArtifactTreeIdentity,
  sameArtifactTreeIdentity,
  type ArtifactTreeIdentity,
} from './loadArtifactInput';

export const BROWSER_BUDGET_SCHEMA_VERSION = 'airspace-browser-budgets.v1' as const;
export const DEFAULT_BROWSER_BUDGETS = RUNTIME_POLICY_LIMITS.browser.bundle;

export type BrowserBudgetTarget = 'production' | 'mock-staging';

export interface BrowserBudgetLimits {
  readonly initialShellGzipBytes: number;
  readonly lazyMapGzipBytes: number;
}

export interface BrowserBudgetAsset {
  readonly path: string;
  readonly bytes: number;
  readonly gzipBytes: number;
}

export interface BrowserBudgetReport {
  readonly schemaVersion: typeof BROWSER_BUDGET_SCHEMA_VERSION;
  readonly artifact: {
    readonly target: BrowserBudgetTarget;
    readonly clientIdentity: ArtifactTreeIdentity;
  };
  readonly initialShell: {
    readonly limitGzipBytes: number;
    readonly totalGzipBytes: number;
    readonly assets: readonly BrowserBudgetAsset[];
  };
  readonly lazyMap: {
    readonly limitGzipBytes: number;
    readonly totalGzipBytes: number;
    readonly assets: readonly BrowserBudgetAsset[];
  };
  readonly styles: {
    readonly totalBytes: number;
    readonly totalGzipBytes: number;
    readonly assets: readonly BrowserBudgetAsset[];
  };
  readonly fonts: {
    readonly totalBytes: number;
    readonly totalGzipBytes: number;
    readonly assets: readonly BrowserBudgetAsset[];
  };
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe-integer byte limit.`);
  }
}

function relativeAssetPath(value: string, label: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '');
  if (
    normalized.length === 0 ||
    value.includes('\\') ||
    /^\/{2,}/u.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ||
    normalized.includes('?') ||
    normalized.includes('#') ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`${label} contains an invalid generated asset path.`);
  }
  const path = posix.normalize(normalized);
  if (!path.startsWith('assets/') || !path.endsWith('.js')) {
    throw new Error(`${label} must reference a generated JavaScript asset.`);
  }
  return path;
}

function htmlInitialModules(html: string): {
  readonly entryPath: string;
  readonly seedPaths: readonly string[];
} {
  const document = parseHtml(html);
  const elements: DefaultTreeAdapterTypes.Element[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ('tagName' in node) elements.push(node);
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  };
  visit(document);
  const attribute = (element: DefaultTreeAdapterTypes.Element, name: string) =>
    element.attrs.find((entry) => entry.name === name)?.value;
  const scripts: string[] = [];
  for (const element of elements.filter((entry) => entry.tagName === 'script')) {
    const source = attribute(element, 'src');
    const type = attribute(element, 'type');
    if (source === undefined || type !== 'module') {
      throw new Error('live.html may contain only external module scripts.');
    }
    scripts.push(relativeAssetPath(source, 'live.html'));
  }
  const unique = [...new Set(scripts)].sort(comparePath);
  if (unique.length === 0 || unique.length !== scripts.length) {
    throw new Error('live.html must contain a non-empty, duplicate-free module script set.');
  }
  const entries = unique.filter((path) => /^assets\/live-main-[A-Za-z0-9_-]+\.js$/u.test(path));
  if (entries.length !== 1) {
    throw new Error('live.html must contain exactly one generated live-main entry.');
  }
  const preloads: string[] = [];
  for (const element of elements.filter((entry) => entry.tagName === 'link')) {
    const relations = (attribute(element, 'rel') ?? '').toLowerCase().split(/\s+/u);
    if (!relations.includes('modulepreload')) continue;
    const reference = attribute(element, 'href');
    if (reference === undefined) {
      throw new Error('live.html contains a modulepreload without an href.');
    }
    preloads.push(relativeAssetPath(reference, 'live.html modulepreload'));
  }
  if (new Set(preloads).size !== preloads.length) {
    throw new Error('live.html must contain a duplicate-free modulepreload set.');
  }
  return {
    entryPath: entries[0]!,
    seedPaths: [...new Set([...unique, ...preloads])].sort(comparePath),
  };
}

function referencedJsPath(specifier: string, importerPath: string, label: string): string {
  if (
    !specifier.startsWith('./') &&
    !specifier.startsWith('../') &&
    !specifier.startsWith('/assets/') &&
    !specifier.startsWith('assets/')
  ) {
    throw new Error(`${label} contains a non-local module reference: ${importerPath}`);
  }
  const path = specifier.startsWith('/assets/')
    ? specifier.slice(1)
    : specifier.startsWith('assets/')
      ? specifier
      : posix.join(posix.dirname(importerPath), specifier);
  return relativeAssetPath(path, label);
}

function isDynamicImport(type: ImportType): boolean {
  return (
    type === ImportType.Dynamic ||
    type === ImportType.DynamicSourcePhase ||
    type === ImportType.DynamicDeferPhase
  );
}

function isWorkerConstructor(expression: ts.Expression): boolean {
  return (
    (ts.isIdentifier(expression) && ['Worker', 'SharedWorker'].includes(expression.text)) ||
    (ts.isPropertyAccessExpression(expression) &&
      ['Worker', 'SharedWorker'].includes(expression.name.text))
  );
}

function isImportMetaUrl(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'url' &&
    ts.isMetaProperty(expression.expression) &&
    expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    expression.expression.name.text === 'meta'
  );
}

function literalWorkerSpecifier(expression: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (
    !ts.isNewExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== 'URL' ||
    expression.arguments === undefined ||
    expression.arguments.length !== 2
  ) {
    return undefined;
  }
  const [specifier, base] = expression.arguments;
  if (
    specifier === undefined ||
    base === undefined ||
    (!ts.isStringLiteral(specifier) && !ts.isNoSubstitutionTemplateLiteral(specifier)) ||
    !isImportMetaUrl(base)
  ) {
    return undefined;
  }
  return specifier.text;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function isModuleWorkerOptions(expression: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(expression) || expression.properties.length !== 1) {
    return false;
  }
  const [property] = expression.properties;
  return (
    property !== undefined &&
    ts.isPropertyAssignment(property) &&
    propertyNameText(property.name) === 'type' &&
    (ts.isStringLiteral(property.initializer) ||
      ts.isNoSubstitutionTemplateLiteral(property.initializer)) &&
    property.initializer.text === 'module'
  );
}

function isPinnedMapLibreWorkerFactory(
  workers: readonly ts.NewExpression[],
  importerPath: string,
): boolean {
  if (!/^assets\/mapRenderer-[A-Za-z0-9_-]+\.js$/u.test(importerPath) || workers.length !== 2) {
    return false;
  }
  if (
    workers.some(
      (worker) =>
        !ts.isIdentifier(worker.expression) ||
        worker.expression.text !== 'Worker' ||
        worker.arguments === undefined,
    )
  ) {
    return false;
  }
  const argumentsByWorker = workers.map((worker) => [...worker.arguments!]);
  const workerIdentifiers = argumentsByWorker.map(([argument]) =>
    argument !== undefined && ts.isIdentifier(argument) ? argument.text : undefined,
  );
  if (workerIdentifiers[0] === undefined || workerIdentifiers[0] !== workerIdentifiers[1]) {
    return false;
  }
  return (
    argumentsByWorker.filter((arguments_) => arguments_.length === 1).length === 1 &&
    argumentsByWorker.filter(
      (arguments_) =>
        arguments_.length === 2 &&
        arguments_[1] !== undefined &&
        isModuleWorkerOptions(arguments_[1]),
    ).length === 1
  );
}

function workerJsReferences(source: string, importerPath: string): readonly string[] {
  const sourceFile = ts.createSourceFile(
    importerPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const references = new Set<string>();
  const computedWorkers: ts.NewExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && isWorkerConstructor(node.expression)) {
      const argument = node.arguments?.[0];
      const specifier = argument === undefined ? undefined : literalWorkerSpecifier(argument);
      if (specifier === undefined) {
        computedWorkers.push(node);
      } else {
        references.add(referencedJsPath(specifier, importerPath, 'Generated browser worker'));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (computedWorkers.length > 0 && !isPinnedMapLibreWorkerFactory(computedWorkers, importerPath)) {
    throw new Error(
      `Generated browser module contains a computed worker that cannot be measured: ${importerPath}`,
    );
  }
  return [...references].sort(comparePath);
}

function moduleJsReferences(
  source: string,
  importerPath: string,
  includeDynamic: boolean,
  allowOmittedDynamic = false,
): readonly string[] {
  const references = new Set<string>();
  const [imports] = parseModule(source, importerPath);
  for (const specifier of imports) {
    if (specifier.t === ImportType.ImportMeta) continue;
    if (specifier.n === undefined) {
      throw new Error(
        `Generated browser module contains a computed import that cannot be measured: ${importerPath}`,
      );
    }
    const reference = referencedJsPath(specifier.n, importerPath, 'Generated browser import');
    if (!includeDynamic && isDynamicImport(specifier.t)) {
      if (!allowOmittedDynamic) {
        throw new Error(
          `Generated browser module contains an unassigned dynamic import: ${importerPath}`,
        );
      }
      continue;
    }
    references.add(reference);
  }
  for (const reference of workerJsReferences(source, importerPath)) references.add(reference);
  return [...references].sort(comparePath);
}

async function regularAsset(clientRoot: string, path: string): Promise<BrowserBudgetAsset> {
  const absolutePath = join(clientRoot, ...path.split('/'));
  const metadata = await lstat(absolutePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Browser budget asset is missing: ${path}`);
    }
    throw error;
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Browser budget asset must be a regular file: ${path}`);
  }
  const contents = await readFile(absolutePath);
  if (contents.byteLength !== metadata.size) {
    throw new Error(`Browser budget asset changed while it was read: ${path}`);
  }
  return {
    path,
    bytes: contents.byteLength,
    gzipBytes: gzipSync(contents, { level: 9 }).byteLength,
  };
}

async function generatedAssetGroup(
  clientRoot: string,
  pattern: RegExp,
  label: string,
): Promise<BrowserBudgetReport['styles']> {
  const paths = (await generatedAssetPaths(clientRoot, label)).filter((path) => pattern.test(path));
  if (paths.length === 0) throw new Error(`${label} must contain at least one generated file.`);
  const assets = await Promise.all(paths.map((path) => regularAsset(clientRoot, path)));
  return Object.freeze({
    totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    totalGzipBytes: assets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    assets: Object.freeze(assets),
  });
}

async function generatedAssetPaths(clientRoot: string, label: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const visit = async (relativeDirectory: string): Promise<void> => {
    const entries = await readdir(join(clientRoot, ...relativeDirectory.split('/')), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((left, right) => comparePath(left.name, right.name))) {
      const path = `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link: ${path}`);
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        paths.push(path);
      } else {
        throw new Error(`${label} contains a non-regular generated entry: ${path}`);
      }
    }
  };
  await visit('assets');
  return paths;
}

async function lazyMapClosure(
  clientRoot: string,
  entryPath: string,
  initialShell: ReadonlySet<string>,
): Promise<readonly string[]> {
  const entrySource = await readFile(join(clientRoot, ...entryPath.split('/')), 'utf8');
  const [entryImports] = parseModule(entrySource, entryPath);
  const dynamicImports = entryImports.filter((specifier) => isDynamicImport(specifier.t));
  const declaredEntryLazyRoles = [
    ['map', /^mapRenderer-[A-Za-z0-9_-]+\.js$/u],
    ['chart', /^liveChartRenderer-[A-Za-z0-9_-]+\.js$/u],
    ['lab', /^LabApp-[A-Za-z0-9_-]+\.js$/u],
    ['replay', /^ReplayApp-[A-Za-z0-9_-]+\.js$/u],
    ['evidence', /^OnlineEvidenceApp-[A-Za-z0-9_-]+\.js$/u],
  ] as const;
  const lazyByRole = new Map<string, string>();
  for (const specifier of dynamicImports) {
    if (specifier.n === undefined) {
      throw new Error('The live entry contains a computed dynamic import.');
    }
    const path = referencedJsPath(specifier.n, entryPath, 'Live entry lazy import');
    const role = declaredEntryLazyRoles.find(([, pattern]) =>
      pattern.test(posix.basename(path)),
    )?.[0];
    if (role === undefined) {
      throw new Error(`The live entry contains an undeclared lazy import: ${path}`);
    }
    if (lazyByRole.has(role)) {
      throw new Error(`The live entry contains duplicate ${role} lazy imports.`);
    }
    lazyByRole.set(role, path);
  }
  const dynamicMapImport = lazyByRole.get('map');
  if (dynamicMapImport === undefined) {
    throw new Error('The live entry must contain exactly one generated lazy map import.');
  }
  const mapWorkers = (
    await generatedAssetPaths(clientRoot, 'Lazy map generated asset inventory')
  ).filter((path) => /^maplibre-gl-worker-[A-Za-z0-9_-]+\.js$/u.test(posix.basename(path)));
  if (mapWorkers.length !== 1) {
    throw new Error('The connected client must contain exactly one generated MapLibre worker.');
  }
  const pending = [dynamicMapImport, mapWorkers[0]!];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path) || initialShell.has(path)) continue;
    relativeAssetPath(path, 'Lazy map graph');
    const metadata = await lstat(join(clientRoot, ...path.split('/'))).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Lazy map graph references a missing JavaScript asset: ${path}`);
      }
      throw error;
    });
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Lazy map graph contains a non-regular JavaScript asset: ${path}`);
    }
    visited.add(path);
    if (/^maplibre-gl-worker-[A-Za-z0-9_-]+\.js$/u.test(posix.basename(path))) continue;
    const source = await readFile(join(clientRoot, ...path.split('/')), 'utf8');
    for (const reference of moduleJsReferences(source, path, true)) pending.push(reference);
  }
  return [...visited].sort(comparePath);
}

async function eagerClosure(
  clientRoot: string,
  seedPaths: readonly string[],
  entryPath: string,
): Promise<readonly string[]> {
  const pending = [...seedPaths];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    relativeAssetPath(path, 'Initial shell graph');
    const metadata = await lstat(join(clientRoot, ...path.split('/'))).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Initial shell graph references a missing JavaScript asset: ${path}`);
      }
      throw error;
    });
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Initial shell graph contains a non-regular JavaScript asset: ${path}`);
    }
    visited.add(path);
    const source = await readFile(join(clientRoot, ...path.split('/')), 'utf8');
    for (const reference of moduleJsReferences(source, path, false, path === entryPath)) {
      pending.push(reference);
    }
  }
  return [...visited].sort(comparePath);
}

export async function verifyBrowserBudgets(
  artifactRoot: string,
  target: BrowserBudgetTarget,
  limits: Readonly<BrowserBudgetLimits> = DEFAULT_BROWSER_BUDGETS,
): Promise<Readonly<BrowserBudgetReport>> {
  await initializeModuleLexer;
  assertLimit(limits.initialShellGzipBytes, 'Initial shell gzip budget');
  assertLimit(limits.lazyMapGzipBytes, 'Lazy map gzip budget');
  const root = resolve(artifactRoot);
  const clientRoot = join(root, 'client');
  const clientIdentityBefore = await captureArtifactTreeIdentity(clientRoot);
  const html = await readFile(join(clientRoot, 'live.html'), 'utf8');
  const initialModules = htmlInitialModules(html);
  const initialPaths = await eagerClosure(
    clientRoot,
    initialModules.seedPaths,
    initialModules.entryPath,
  );
  const entryPath = initialModules.entryPath;
  const lazyPaths = await lazyMapClosure(clientRoot, entryPath, new Set(initialPaths));
  const initialAssets = await Promise.all(
    initialPaths.map((path) => regularAsset(clientRoot, path)),
  );
  const lazyAssets = await Promise.all(lazyPaths.map((path) => regularAsset(clientRoot, path)));
  const styles = await generatedAssetGroup(clientRoot, /\.css$/u, 'Generated style inventory');
  const fonts = await generatedAssetGroup(
    clientRoot,
    /\.(?:woff2?|ttf|otf)$/u,
    'Generated font inventory',
  );
  const initialTotal = initialAssets.reduce((sum, asset) => sum + asset.gzipBytes, 0);
  const lazyTotal = lazyAssets.reduce((sum, asset) => sum + asset.gzipBytes, 0);
  if (initialTotal > limits.initialShellGzipBytes) {
    throw new Error(
      `Initial shell is ${initialTotal} gzip bytes, above the ${limits.initialShellGzipBytes}-byte budget.`,
    );
  }
  if (lazyTotal > limits.lazyMapGzipBytes) {
    throw new Error(
      `Lazy map is ${lazyTotal} gzip bytes, above the ${limits.lazyMapGzipBytes}-byte budget.`,
    );
  }
  const clientIdentityAfter = await captureArtifactTreeIdentity(clientRoot);
  if (!sameArtifactTreeIdentity(clientIdentityBefore, clientIdentityAfter)) {
    throw new Error('Connected client artifact changed while browser budgets were measured.');
  }
  return Object.freeze({
    schemaVersion: BROWSER_BUDGET_SCHEMA_VERSION,
    artifact: Object.freeze({
      target,
      clientIdentity: Object.freeze(clientIdentityBefore),
    }),
    initialShell: Object.freeze({
      limitGzipBytes: limits.initialShellGzipBytes,
      totalGzipBytes: initialTotal,
      assets: Object.freeze(initialAssets),
    }),
    lazyMap: Object.freeze({
      limitGzipBytes: limits.lazyMapGzipBytes,
      totalGzipBytes: lazyTotal,
      assets: Object.freeze(lazyAssets),
    }),
    styles,
    fonts,
  });
}

async function main(arguments_: readonly string[]): Promise<void> {
  const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const roots =
    arguments_.length > 0
      ? arguments_.map((path) => resolve(path))
      : [join(repositoryRoot, 'dist-live'), join(repositoryRoot, 'dist-mock-staging')];
  const reports = [];
  for (const root of roots) {
    const directory = basename(root);
    const target =
      directory === 'dist-live'
        ? 'production'
        : directory === 'dist-mock-staging'
          ? 'mock-staging'
          : undefined;
    if (target === undefined) {
      throw new Error(
        'Browser budget inputs must be named dist-live or dist-mock-staging so the receipt has an allowlisted target identity.',
      );
    }
    reports.push(await verifyBrowserBudgets(root, target));
  }
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
