import { analyzeTemporalScenario } from '../investigation/analyze';
import type { TemporalLabel, TemporalModelScore } from '../ml/temporalTypes';
import {
  CAMPAIGN_WORKER_PROTOCOL_VERSION,
  isCampaignWorkerRequest,
  type CampaignWorkerRequest,
  type CampaignWorkerResponse,
} from '../campaign/worker-protocol';
import { campaignScenarioFromSpec, runCampaign } from '../campaign/runner';
import type {
  BuiltCampaignScenario,
  CampaignDetection,
  CampaignEvaluation,
  CampaignExpectedDetection,
  CampaignProgress,
  CampaignProfileSpec,
  CampaignResult,
  CampaignScenarioVariation,
  CampaignSpec,
} from '../campaign/types';
import { generateTemporalScenario, getTemporalFaultDefinition } from '../temporal/generator';
import type {
  MissionPhase,
  TemporalFaultId,
  TemporalFaultLabel as GroundTruthFaultLabel,
  TemporalScenario,
} from '../temporal/types';
import { SUPPORTED_TEMPORAL_CAMPAIGN_PROFILE } from '../campaign/defaultTemporalCampaign';

export type TemporalCampaignProgressCallback = (progress: CampaignProgress) => void;

export type TemporalCampaignExecutor = (
  spec: CampaignSpec,
  signal: AbortSignal,
  onProgress: TemporalCampaignProgressCallback,
) => Promise<CampaignResult>;

function cancellationError(): Error {
  const error = new Error('Temporal campaign execution was cancelled.');
  error.name = 'AbortError';
  return error;
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw cancellationError();
}

function yieldToWorkerEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export class UnsupportedTemporalCampaignProfileError extends Error {
  constructor(profile: CampaignProfileSpec) {
    super(
      `Unsupported temporal campaign profile '${profile.profileId}@${profile.profileVersion}'. ` +
        `The synthetic temporal generator supports only '${SUPPORTED_TEMPORAL_CAMPAIGN_PROFILE.profileId}@${SUPPORTED_TEMPORAL_CAMPAIGN_PROFILE.profileVersion}'.`,
    );
    this.name = 'UnsupportedTemporalCampaignProfileError';
  }
}

function requireSupportedProfile(profile: CampaignProfileSpec): void {
  if (
    profile.profileId !== SUPPORTED_TEMPORAL_CAMPAIGN_PROFILE.profileId ||
    profile.profileVersion !== SUPPORTED_TEMPORAL_CAMPAIGN_PROFILE.profileVersion
  ) {
    throw new UnsupportedTemporalCampaignProfileError(profile);
  }
}

const SUPPORTED_ONSET_PHASES = new Set<MissionPhase>([
  'ground',
  'takeoff',
  'climb',
  'cruise',
  'descent',
  'landing',
]);

function variationOnsetPhase(variation: CampaignScenarioVariation): MissionPhase {
  if (!SUPPORTED_ONSET_PHASES.has(variation.onsetPhase as MissionPhase)) {
    throw new Error(
      `Unsupported temporal campaign onset phase '${variation.onsetPhase}' in variation '${variation.variationId}'.`,
    );
  }
  return variation.onsetPhase as MissionPhase;
}

function generatorScenarioId(
  scenarioId: string,
  variation?: CampaignScenarioVariation,
): TemporalFaultId | 'nominal' {
  const requestedId = variation?.generatorScenarioId ?? scenarioId;
  if (requestedId === 'nominal') return 'nominal';
  const normalized = requestedId === 'sensor-lag' ? 'lag' : requestedId;
  if (getTemporalFaultDefinition(normalized) === undefined) {
    throw new Error(`Unsupported temporal campaign scenario '${requestedId}'.`);
  }
  return normalized as TemporalFaultId;
}

function modelLabelForFault(faultId: TemporalFaultId): TemporalLabel {
  return faultId === 'lag' ? 'sensor-lag' : faultId;
}

/** Resolves the point-in-time ground truth used for advisory model calibration. */
export function expectedTemporalModelLabelAtPoint(
  activeLabels: readonly Pick<GroundTruthFaultLabel, 'faultId' | 'lifecycle'>[],
): TemporalLabel {
  const faultIds = [...new Set(activeLabels.map(({ faultId }) => faultId))];
  if (faultIds.length === 0) return 'nominal';
  if (faultIds.length > 1) return 'simultaneous-faults';
  return modelLabelForFault(faultIds[0]!);
}

function modelAdvisory(score: TemporalModelScore | null): Record<string, unknown> {
  if (score === null) {
    return {
      authority: 'advisory-only',
      status: 'warmup',
      authoritative: false,
    };
  }
  return {
    authority: 'advisory-only',
    authoritative: false,
    modelVersion: score.modelVersion,
    predictedLabel: score.predictedLabel,
    relativeScore: score.relativeScore,
    abstained: score.abstained,
    anomalous: score.anomalous,
    qualityGatePassed: score.qualityGatePassed,
  };
}

function observedOnlyEvaluation(
  scenario: TemporalScenario,
  expectedDetections: readonly CampaignExpectedDetection[],
): CampaignEvaluation {
  const investigation = analyzeTemporalScenario(scenario, { modelEnabled: true });
  const scenarioStartMs = Date.parse(scenario.startedAt);
  const expectedOnsetByRule = new Map(
    expectedDetections.map(({ ruleId, episodeStartMs }) => [ruleId, episodeStartMs]),
  );
  const retainedBeforeOnsetOrUnexpected = new Set<string>();
  const retainedAtOrAfterOnset = new Set<string>();
  const detections: CampaignDetection[] = [];
  for (const indication of investigation.indications) {
    const detectedAtMs = Math.max(0, indication.timestampMs - scenarioStartMs);
    const expectedOnsetMs = expectedOnsetByRule.get(indication.ruleId);
    const atOrAfterExpectedOnset = expectedOnsetMs !== undefined && detectedAtMs >= expectedOnsetMs;
    const retainedRules = atOrAfterExpectedOnset
      ? retainedAtOrAfterOnset
      : retainedBeforeOnsetOrUnexpected;
    if (retainedRules.has(indication.ruleId)) continue;
    retainedRules.add(indication.ruleId);
    const point = investigation.points[indication.sampleIndex];
    detections.push({
      ruleId: indication.ruleId,
      detectedAtMs,
      details: {
        authority: 'deterministic-rules',
        authoritative: true,
        evidenceSource: 'observed-telemetry-only',
        indicationId: indication.indicationId,
        label: indication.label,
        severity: indication.severity,
        sampleIndex: indication.sampleIndex,
        sensorIds: [...indication.sensorIds],
        expectedCondition: indication.expectedCondition,
        modelAdvisory: modelAdvisory(point?.model.score ?? null),
      },
    });
  }

  const calibration = investigation.points.flatMap((point) => {
    const score = point.model.score;
    if (score === null) return [];
    const abstained = score.abstained || !score.activation.active;
    const expectedLabel = expectedTemporalModelLabelAtPoint(point.activeGroundTruthLabels);
    return [
      {
        confidence: score.relativeScore,
        correct: !abstained && score.predictedLabel === expectedLabel,
        abstained,
      },
    ];
  });

  return {
    detections,
    calibration,
    syntheticDurationMs: (scenario.samples.length - 1) * scenario.cadenceMs,
  };
}

/** Executes the real deterministic temporal campaign without depending on worker globals. */
export async function executeTemporalCampaign(
  spec: CampaignSpec,
  signal: AbortSignal,
  onProgress: TemporalCampaignProgressCallback = () => undefined,
): Promise<CampaignResult> {
  return runCampaign<TemporalScenario>(
    spec,
    {
      buildScenario: async (context): Promise<BuiltCampaignScenario<TemporalScenario>> => {
        if (context.caseIndex > 0) await yieldToWorkerEventLoop();
        requireActive(signal);
        requireSupportedProfile(context.profile);
        const variation = context.scenario.variation;
        const input = generateTemporalScenario({
          seed: context.seed,
          scenarioId: generatorScenarioId(context.scenario.scenarioId, variation),
          sampleCount: 180,
          cadenceMs: 1_000,
          startedAt: spec.createdAt,
          ...(variation === undefined
            ? {}
            : {
                severityScale: variation.severityScale,
                durationScale: variation.durationScale,
                onsetPhase: variationOnsetPhase(variation),
              }),
        });
        requireActive(signal);
        return campaignScenarioFromSpec(input, context.scenario);
      },
      evaluateScenario: (scenario, context): CampaignEvaluation => {
        requireActive(signal);
        const evaluation = observedOnlyEvaluation(
          scenario.input,
          scenario.expectedDetections ?? context.scenario.expectedDetections,
        );
        requireActive(signal);
        return evaluation;
      },
    },
    { signal, onProgress },
  );
}

async function emptyCancelledResult(spec: CampaignSpec): Promise<CampaignResult> {
  const controller = new AbortController();
  controller.abort('cancelled-without-partial-evidence');
  return runCampaign<never>(
    spec,
    {
      buildScenario: () => {
        throw cancellationError();
      },
      evaluateScenario: () => {
        throw cancellationError();
      },
    },
    { signal: controller.signal },
  );
}

export interface TemporalCampaignWorkerHandler {
  handleMessage(message: unknown): void;
  activeRequestCount(): number;
}

function errorDetails(error: unknown): { name: string; message: string } {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  };
}

function requestIdFromMalformed(value: unknown): string {
  if (
    typeof value === 'object' &&
    value !== null &&
    'requestId' in value &&
    typeof value.requestId === 'string' &&
    value.requestId !== ''
  ) {
    return value.requestId;
  }
  return 'invalid-request';
}

export function createTemporalCampaignWorkerHandler(
  postMessage: (response: CampaignWorkerResponse) => void,
  executor: TemporalCampaignExecutor = executeTemporalCampaign,
): TemporalCampaignWorkerHandler {
  let activeRequest: { requestId: string; controller: AbortController } | null = null;

  const respondError = (requestId: string, error: unknown): void => {
    postMessage({
      protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
      type: 'campaign.error',
      requestId,
      error: errorDetails(error),
    });
  };

  const run = async (
    request: Extract<CampaignWorkerRequest, { type: 'campaign.run' }>,
    controller: AbortController,
  ): Promise<void> => {
    try {
      const result = await executor(request.spec, controller.signal, (progress) => {
        postMessage({
          protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
          type: 'campaign.progress',
          requestId: request.requestId,
          progress,
        });
      });
      if (result.status === 'cancelled') {
        postMessage({
          protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
          type: 'campaign.cancelled',
          requestId: request.requestId,
          completedCases: result.summary.completedCases,
          result,
        });
      } else {
        postMessage({
          protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
          type: 'campaign.result',
          requestId: request.requestId,
          result,
        });
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        const result = await emptyCancelledResult(request.spec);
        postMessage({
          protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
          type: 'campaign.cancelled',
          requestId: request.requestId,
          completedCases: result.summary.completedCases,
          result,
        });
      } else {
        respondError(request.requestId, error);
      }
    } finally {
      if (activeRequest?.requestId === request.requestId) activeRequest = null;
    }
  };

  return {
    handleMessage(message: unknown): void {
      if (!isCampaignWorkerRequest(message)) {
        respondError(
          requestIdFromMalformed(message),
          new Error('Malformed campaign worker request.'),
        );
        return;
      }
      if (message.type === 'campaign.cancel') {
        if (activeRequest?.requestId !== message.requestId) {
          respondError(
            message.requestId,
            new Error('No active campaign request matches this cancellation.'),
          );
          return;
        }
        activeRequest.controller.abort('campaign.cancel');
        return;
      }
      if (activeRequest !== null) {
        respondError(
          message.requestId,
          new Error(
            activeRequest.requestId === message.requestId
              ? 'Duplicate active campaign request ID.'
              : 'Only one temporal campaign request may be active.',
          ),
        );
        return;
      }
      const controller = new AbortController();
      activeRequest = { requestId: message.requestId, controller };
      void run(message, controller);
    },
    activeRequestCount: () => (activeRequest === null ? 0 : 1),
  };
}

interface WorkerScopeLike {
  postMessage(message: CampaignWorkerResponse): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
}

function activeWorkerScope(): WorkerScopeLike | null {
  const candidate = globalThis as unknown as {
    document?: unknown;
    postMessage?: unknown;
    addEventListener?: unknown;
  };
  if (
    candidate.document === undefined &&
    typeof candidate.postMessage === 'function' &&
    typeof candidate.addEventListener === 'function'
  ) {
    return candidate as WorkerScopeLike;
  }
  return null;
}

const workerScope = activeWorkerScope();
if (workerScope !== null) {
  const handler = createTemporalCampaignWorkerHandler((response) =>
    workerScope.postMessage(response),
  );
  workerScope.addEventListener('message', (event) => handler.handleMessage(event.data));
}
