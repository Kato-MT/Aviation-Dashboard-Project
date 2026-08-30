/* global console, process */

import { resolve } from 'node:path';

import {
  DEFAULT_MANIFEST_PATH,
  verifySelectedR3EvidenceManifest,
  writeSelectedR3EvidenceManifest,
} from './selectedR3Evidence';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const command = process.argv[2];

if (command === 'refresh') {
  const manifest = await writeSelectedR3EvidenceManifest(repositoryRoot);
  console.log(
    `selected-r3-evidence: refreshed ${DEFAULT_MANIFEST_PATH} with ${manifest.evidence.fileCount} regular files and collection SHA-256 ${manifest.evidence.collectionSha256}`,
  );
} else if (command === 'check') {
  const manifest = await verifySelectedR3EvidenceManifest(repositoryRoot);
  console.log(
    `selected-r3-evidence: verified ${manifest.contract.requirementIds.length} requirements, ${manifest.contract.testCases.length} tests, ${manifest.evidence.fileCount} regular files, and source-content SHA-256 ${manifest.source.content.sha256}`,
  );
} else {
  throw new Error('Usage: selectedR3EvidenceCli.ts <refresh|check>');
}
