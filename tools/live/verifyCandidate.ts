import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  captureSourceIdentity,
  sameSourceIdentity,
  verifyRetainedCandidate,
  type VerifyCandidateOptions,
} from './retainCandidate';

export { verifyRetainedCandidate } from './retainCandidate';
export type { VerifyCandidateOptions } from './retainCandidate';

function cliArguments(arguments_: readonly string[]): VerifyCandidateOptions {
  const candidate = arguments_[0];
  if (candidate === undefined || candidate.startsWith('--')) {
    throw new Error(
      'Usage: tsx tools/live/verifyCandidate.ts <candidate-directory> (--expected-selection-sha256 <sha256> | --expected-candidate-id <id>) [--selection-record <file>] [--expected-source-head <sha>] [--expected-target mock-staging]',
    );
  }
  let expectedSourceHead: string | undefined;
  let expectedTarget: 'mock-staging' | undefined;
  let selectionRecordPath: string | undefined;
  let expectedSelectionRecordSha256: string | undefined;
  let expectedCandidateId: string | undefined;
  for (let index = 1; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag ?? 'CLI argument'}.`);
    }
    if (flag === '--expected-source-head') expectedSourceHead = value;
    else if (flag === '--selection-record') selectionRecordPath = value;
    else if (flag === '--expected-selection-sha256') expectedSelectionRecordSha256 = value;
    else if (flag === '--expected-candidate-id') expectedCandidateId = value;
    else if (flag === '--expected-target') {
      if (value !== 'mock-staging') throw new Error(`Unsupported expected target: ${value}`);
      expectedTarget = value;
    } else throw new Error(`Unknown argument: ${flag ?? ''}`);
  }
  return {
    candidateDirectory: candidate,
    ...(selectionRecordPath === undefined ? {} : { selectionRecordPath }),
    ...(expectedSelectionRecordSha256 === undefined ? {} : { expectedSelectionRecordSha256 }),
    ...(expectedCandidateId === undefined ? {} : { expectedCandidateId }),
    ...(expectedSourceHead === undefined ? {} : { expectedSourceHead }),
    ...(expectedTarget === undefined ? {} : { expectedTarget }),
  };
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const options = cliArguments(process.argv.slice(2));
  captureSourceIdentity(repositoryRoot)
    .then(async (expectedSourceIdentity) => {
      const provenance = await verifyRetainedCandidate({ ...options, expectedSourceIdentity });
      const sourceAfter = await captureSourceIdentity(repositoryRoot);
      if (!sameSourceIdentity(expectedSourceIdentity, sourceAfter)) {
        throw new Error('Exact checkout source changed during candidate verification.');
      }
      return provenance;
    })
    .then(
      (provenance) => {
        console.log(
          `Verified ${provenance.candidateId}. No write, rebuild, deployment, or network request was performed.`,
        );
      },
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      },
    );
}
