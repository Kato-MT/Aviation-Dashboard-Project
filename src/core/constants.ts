import type { AdapterInputLimits } from './types';

/** Version of the complete workbench release assembled by the repository. */
export const APPLICATION_VERSION = '2.0.0';

/** Version of the deterministic adapters, profile engine, and verification contracts. */
export const DETERMINISTIC_CORE_VERSION = '2.0.0';

export const DEFAULT_INPUT_LIMITS: Readonly<AdapterInputLimits> = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxSamples: 250_000,
});

export const DEFAULT_SOURCE_ID = 'synthetic-source-1';
