const EXACT_SOURCE_SHA = /^[a-f0-9]{40}$/u;

function normalizedSourceSha(value: string | undefined, label: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!EXACT_SOURCE_SHA.test(normalized)) {
    throw new Error(`${label} must be a full 40-character Git SHA.`);
  }
  return normalized;
}

/**
 * Independent browser-test oracle for the identity requested by the runner.
 * Local development has no exact source claim; hosted candidate jobs inherit
 * the same GitHub SHA that the client and Worker must expose.
 */
export function expectedReleaseSha(environment: NodeJS.ProcessEnv = process.env): string {
  const candidateSourceHead = normalizedSourceSha(
    environment.M34_EXPECTED_SOURCE_HEAD,
    'M34_EXPECTED_SOURCE_HEAD',
  );
  const githubSourceHead = normalizedSourceSha(environment.GITHUB_SHA, 'GITHUB_SHA');
  if (candidateSourceHead && githubSourceHead && candidateSourceHead !== githubSourceHead) {
    throw new Error('M34_EXPECTED_SOURCE_HEAD and GITHUB_SHA identify different source revisions.');
  }
  return candidateSourceHead ?? githubSourceHead ?? 'local-unreleased';
}
