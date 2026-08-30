import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

async function workflow(name: string): Promise<string> {
  return readFile(resolve('.github', 'workflows', name), 'utf8');
}

async function projectFile(path: string): Promise<string> {
  return readFile(resolve(path), 'utf8');
}

function section(source: string, start: string, end: string): string {
  const startPosition = source.indexOf(start);
  const endPosition = source.indexOf(end, startPosition + start.length);
  expect(startPosition).toBeGreaterThanOrEqual(0);
  expect(endPosition).toBeGreaterThan(startPosition);
  return source.slice(startPosition, endPosition);
}

function expectOrdered(source: string, markers: readonly string[]): void {
  let cursor = 0;
  for (const marker of markers) {
    const position = source.indexOf(marker, cursor);
    expect(position, `missing or out-of-order workflow marker: ${marker}`).toBeGreaterThanOrEqual(
      cursor,
    );
    cursor = position + marker.length;
  }
}

describe('v3 publication firebreaks', () => {
  it('builds once, retains, tests with zero retries, reverifies, receipts, and uploads', async () => {
    const source = await workflow('ci.yml');
    const liveJob = section(source, '  live-assurance:', '  temporal-evidence:');

    expectOrdered(liveJob, [
      'pnpm build:live',
      'pnpm build:mock-staging',
      'pnpm verify:live-builds',
      'pnpm privacy:verify',
      'pnpm runbooks:verify',
      'pnpm browser:budgets',
      'pnpm test:visual-regression',
      'pnpm test:browser-performance',
      'pnpm worker:dry-run',
      'pnpm sbom:generate',
      'pnpm candidate:retain',
      'pnpm candidate:verify',
      'pnpm live:load:candidate:smoke',
      'pnpm candidate:verify',
      'pnpm test:m34-artifact',
      'pnpm candidate:verify',
      'pnpm runbooks:rehearse:candidate',
      'pnpm candidate:acceptance',
      'pnpm candidate:verify',
      'name: retained-m34-${{ github.sha }}',
    ]);

    expect(liveJob.match(/\bpnpm build:live\b/gu)).toHaveLength(1);
    expect(liveJob.match(/\bpnpm build:mock-staging\b/gu)).toHaveLength(1);
    expect(liveJob.match(/pnpm candidate:verify/gu)).toHaveLength(4);
    expect(liveJob.match(/pnpm worker:dry-run/gu)).toHaveLength(1);
    expect(liveJob.match(/pnpm runbooks:verify/gu)).toHaveLength(1);
    expect(liveJob.match(/pnpm runbooks:rehearse:candidate/gu)).toHaveLength(1);
    expect(liveJob.match(/pnpm test:visual-regression/gu)).toHaveLength(1);
    expect(liveJob.match(/pnpm live:load:candidate:smoke/gu)).toHaveLength(1);
    expect(liveJob).toMatch(
      /name: Run candidate-bound local workerd load smoke gate\s+timeout-minutes: 15\s+shell: pwsh\s+env:\s+M34_EXPECTED_SELECTION_SHA256: \$\{\{ steps\.retain-candidate\.outputs\.selection_sha256 \}\}\s+run: pnpm live:load:candidate:smoke --candidate-directory "\$env:M34_CANDIDATE_DIRECTORY"/u,
    );
    expect(liveJob).toMatch(
      /name: Reverify the unchanged candidate after load execution\s+if: always\(\)\s+shell: pwsh\s+env:\s+M34_EXPECTED_SELECTION_SHA256: \$\{\{ steps\.retain-candidate\.outputs\.selection_sha256 \}\}\s+run: pnpm candidate:verify "\$env:M34_CANDIDATE_DIRECTORY" --selection-record "\$env:M34_SELECTION_RECORD_PATH" --expected-selection-sha256 "\$env:M34_EXPECTED_SELECTION_SHA256" --expected-source-head "\$env:GITHUB_SHA" --expected-target mock-staging/u,
    );
    expect(liveJob).toMatch(
      /name: Rehearse all candidate-bound operator runbooks locally\s+shell: pwsh\s+env:\s+M34_EXPECTED_SELECTION_SHA256: \$\{\{ steps\.retain-candidate\.outputs\.selection_sha256 \}\}\s+run: pnpm runbooks:rehearse:candidate "\$env:M34_CANDIDATE_DIRECTORY" --output "\$env:M34_RUNBOOK_RECEIPT_PATH" --selection-record "\$env:M34_SELECTION_RECORD_PATH" --expected-selection-sha256 "\$env:M34_EXPECTED_SELECTION_SHA256" --expected-source-head "\$env:GITHUB_SHA"/u,
    );
    expect(liveJob).toMatch(
      /run: pnpm candidate:acceptance "\$env:M34_CANDIDATE_DIRECTORY" "\$env:M34_JUNIT_PATH" "\$env:M34_RUNBOOK_RECEIPT_PATH" --output "\$env:M34_RECEIPT_PATH"/u,
    );
    expect(liveJob).not.toContain('live:load:maximum');
    expect(liveJob).not.toContain('live:load:soak');
    const retainedChain = liveJob.slice(liveJob.indexOf('pnpm candidate:retain'));
    expect(retainedChain).not.toMatch(/\bpnpm\s+build(?::[\w-]+)?\b/u);
    expect(liveJob).toContain('M34_EXPECTED_SOURCE_HEAD: ${{ github.sha }}');
    expect(liveJob).toContain('M34_SELECTION_RECORD_PATH: .tmp-tests/retained-m34.selection.json');
    expect(liveJob).toContain(
      'M34_RUNBOOK_RECEIPT_PATH: test-results/m34-entry-artifact/runbook-rehearsal.json',
    );
    expect(liveJob).toContain('id: retain-candidate');
    expect(liveJob).toContain('M34_CANDIDATE_SELECTION *');
    expect(liveJob).toContain('$selection.selectionRecordSha256');
    expect(liveJob).not.toContain('Get-FileHash');
    expect(liveJob).toContain('GITHUB_OUTPUT');
    expect(liveJob.match(/steps\.retain-candidate\.outputs\.selection_sha256/gu)).toHaveLength(8);
    expect(liveJob).toContain('!.tmp-tests/worker-dry-run/**/*.map');
    expect(liveJob).toContain('include-hidden-files: true');
    expect(liveJob).toContain('if-no-files-found: error');
    expect(liveJob).toContain('test-results/m34-entry-artifact');
    expect(liveJob).toContain('test-results/live-load');
    expect(liveJob).toContain('test-results/visual-regression');
  });

  it('keeps maximum and soak load profiles as explicit manual-only scripts', async () => {
    const packageSource = await projectFile('package.json');
    const source = await workflow('ci.yml');

    expect(packageSource).toContain(
      '"live:load:smoke": "tsx tools/live/loadHarness.ts --artifact-root dist-mock-staging --profile smoke --output test-results/live-load/smoke.json"',
    );
    expect(packageSource).toContain(
      '"live:load:maximum": "tsx tools/live/loadHarness.ts --artifact-root dist-mock-staging --profile maximum --output test-results/live-load/maximum.json"',
    );
    expect(packageSource).toContain(
      '"live:load:soak": "tsx tools/live/loadHarness.ts --artifact-root dist-mock-staging --profile soak --output test-results/live-load/soak.json"',
    );
    expect(packageSource).toContain(
      '"live:load:candidate:smoke": "tsx tools/live/loadHarness.ts --profile smoke --output test-results/live-load/candidate-smoke.json"',
    );
    expect(packageSource).toContain(
      '"runbooks:rehearse:candidate": "tsx tools/live/rehearseCandidateRunbooks.ts"',
    );
    expect(source).not.toContain('live:load:maximum');
    expect(source).not.toContain('live:load:soak');
  });

  it('runs heavy candidate assurance only for main, pull requests, or manual dispatch', async () => {
    const source = await workflow('ci.yml');
    const liveJob = section(source, '  live-assurance:', '  temporal-evidence:');

    expect(liveJob).toContain(
      "if: github.event_name == 'workflow_dispatch' || github.event_name == 'pull_request' || github.ref == 'refs/heads/main'",
    );
    expect(source).toContain('LIVE_ASSURANCE_RESULT: ${{ needs.live-assurance.result }}');
    expect(source).toContain(
      'if [[ "$EVENT_NAME" == "push" && "$GIT_REF" != "refs/heads/main" ]]; then',
    );
    expect(source).toContain('test "$LIVE_ASSURANCE_RESULT" = "skipped"');
    expect(source).toContain('test "$LIVE_ASSURANCE_RESULT" = "success"');
    expect(source).toContain(
      'node scripts/release/verify-traceability.mjs --require-evidence-paths',
    );
  });

  it('binds M3.4 Playwright to the retained full-stack candidate with zero retries', async () => {
    const config = await projectFile('playwright.m34.config.ts');
    const acceptance = await projectFile('tests/live-browser/m34-entry-artifact.spec.ts');

    expect(config).toContain('retries: 0');
    expect(config).toContain("command: 'pnpm exec tsx tools/live/serveCandidate.ts'");
    expect(config).toContain('M34_CANDIDATE_DIRECTORY is required');
    expect(config).toContain('M34_EXPECTED_SELECTION_SHA256');
    expect(config).toContain('M34_EXPECTED_CANDIDATE_ID');
    expect(config).not.toMatch(/\bpnpm\s+build(?::[\w-]+)?\b/u);
    expect(acceptance).toContain("request.get('/api/v1/regions')");
    expect(acceptance).toContain("page.on('websocket'");
    expect(acceptance).toContain('/map-assets/');
    expect(acceptance).toContain("request.get('/v2.html', { maxRedirects: 0 })");
    expect(acceptance).toContain(
      "request.get('/Aviation-Dashboard-Project/', { maxRedirects: 0 })",
    );
    expect(acceptance).toContain("request.get('/_redirects'");
    expect(acceptance).toContain("request.get('/__m34/runtime-egress')");
  });

  it('keeps retained-candidate acceptance and isolated performance out of the ordinary Live browser suite', async () => {
    const liveConfig = await projectFile('playwright.live.config.ts');

    expect(liveConfig).toContain("'**/m34-entry-artifact.spec.ts'");
    expect(liveConfig).toContain("'**/performance.spec.ts'");
    expect(liveConfig).toContain("'**/visual-regression.spec.ts'");
  });

  it('keeps Pages manual, build-free, and unable to deploy', async () => {
    const source = await workflow('pages.yml');

    expect(source).toContain('workflow_dispatch:');
    expect(source).toContain('candidate_run_id:');
    expect(source).toContain('source_sha:');
    expect(source).toContain('confirm_cutover:');
    expect(source).toContain('Pages publication is paused');
    expect(source).not.toContain('workflow_run:');
    expect(source).not.toMatch(/\bpnpm\s+(?:run\s+)?build\b/u);
    expect(source).not.toContain('actions/deploy-pages');
    expect(source).not.toContain('actions/upload-pages-artifact');
    expect(source).not.toContain('pages: write');
    expect(source).not.toContain('id-token: write');
    expect(source).toMatch(/exit 1\s*$/u);
  });

  it('keeps v2 and v3 release paths mutually exclusive and fail-closed', async () => {
    const legacy = await workflow('release.yml');
    const v3 = await workflow('v3-release-preflight.yml');

    expect(legacy).toContain("- 'v2.*'");
    expect(legacy).not.toContain("- 'v3.*'");
    expect(legacy).toContain('Prevent v3 source from entering the legacy v2 release path');
    expect(legacy).toContain('grep --fixed-strings \'id="workspace"\' index.html');
    expect(legacy.indexOf('[[ "$GITHUB_REF_NAME" == v2.* ]]')).toBeLessThan(
      legacy.indexOf('gh release create'),
    );
    expect(v3).toContain("- 'v3.*'");
    expect(v3).not.toContain("- 'v2.*'");
    expect(v3).toContain('V3 release publication is intentionally blocked');
    expect(v3).toMatch(/exit 1\s*$/u);
    expect(v3).not.toContain('contents: write');
    expect(v3).not.toContain('pages: write');
    expect(v3).not.toContain('id-token: write');
    expect(v3).not.toContain('actions/deploy-pages');
    expect(v3).not.toContain('gh release create');
    expect(v3).not.toMatch(/\bpnpm\s+(?:run\s+)?build\b/u);
  });
});
