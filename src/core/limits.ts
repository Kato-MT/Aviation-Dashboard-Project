import { DEFAULT_INPUT_LIMITS } from './constants';
import type { AdapterInputLimits, ValidationIssue } from './types';

export function resolveInputLimits(overrides?: Partial<AdapterInputLimits>): AdapterInputLimits {
  return {
    maxBytes: overrides?.maxBytes ?? DEFAULT_INPUT_LIMITS.maxBytes,
    maxSamples: overrides?.maxSamples ?? DEFAULT_INPUT_LIMITS.maxSamples,
  };
}

export function utf8ByteLength(input: string): number {
  return new TextEncoder().encode(input).byteLength;
}

export function validateUploadLimits(
  inputBytes: number,
  sampleCount: number,
  overrides?: Partial<AdapterInputLimits>,
): ValidationIssue[] {
  const limits = resolveInputLimits(overrides);
  const issues: ValidationIssue[] = [];

  if (inputBytes > limits.maxBytes) {
    issues.push({
      code: 'UPLOAD_TOO_LARGE',
      disposition: 'fatal',
      message: `Input is ${inputBytes.toLocaleString()} bytes; the maximum is ${limits.maxBytes.toLocaleString()} bytes (10 MiB by default).`,
      observedValue: inputBytes,
      expectedCondition: `byte length <= ${limits.maxBytes}`,
    });
  }

  if (sampleCount > limits.maxSamples) {
    issues.push({
      code: 'SAMPLE_LIMIT_EXCEEDED',
      disposition: 'fatal',
      message: `Input declares ${sampleCount.toLocaleString()} samples; the maximum is ${limits.maxSamples.toLocaleString()}.`,
      observedValue: sampleCount,
      expectedCondition: `sample count <= ${limits.maxSamples}`,
    });
  }

  return issues;
}
