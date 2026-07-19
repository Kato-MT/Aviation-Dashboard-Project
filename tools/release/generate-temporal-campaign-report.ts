import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { buildDefaultTemporalCampaignSpec, serializeCampaignResult } from '../../src/campaign';
import { executeTemporalCampaign } from '../../src/workers/temporalCampaign.worker';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const createdAt = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1_000).toISOString()
  : '2026-07-17T00:00:00.000Z';
const spec = buildDefaultTemporalCampaignSpec([3101, 3102, 3103], createdAt);
const result = await executeTemporalCampaign(spec, new AbortController().signal);

if (
  result.status !== 'completed' ||
  result.summary.failedCases !== 0 ||
  result.summary.completedCases !== result.summary.plannedCases
) {
  throw new Error(
    `Temporal campaign evidence gate failed: ${result.status}, ${result.summary.completedCases}/${result.summary.plannedCases} completed, ${result.summary.failedCases} failed.`,
  );
}

const outputDirectory = resolve(repositoryRoot, 'artifacts');
await mkdir(outputDirectory, { recursive: true });
const outputPath = resolve(outputDirectory, 'temporal-campaign-report.json');
await writeFile(outputPath, serializeCampaignResult(result), 'utf8');
console.log(
  `temporal-campaign-report: wrote ${result.summary.completedCases} verified synthetic cases to ${outputPath}`,
);
