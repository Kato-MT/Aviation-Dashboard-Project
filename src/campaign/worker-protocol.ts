import type { CampaignProgress, CampaignResult, CampaignSpec } from './types';

export const CAMPAIGN_WORKER_PROTOCOL_VERSION = 'campaign-worker.v1' as const;

export type CampaignWorkerRequest =
  | {
      protocolVersion: typeof CAMPAIGN_WORKER_PROTOCOL_VERSION;
      type: 'campaign.run';
      requestId: string;
      spec: CampaignSpec;
    }
  | {
      protocolVersion: typeof CAMPAIGN_WORKER_PROTOCOL_VERSION;
      type: 'campaign.cancel';
      requestId: string;
    };

export type CampaignWorkerResponse =
  | {
      protocolVersion: typeof CAMPAIGN_WORKER_PROTOCOL_VERSION;
      type: 'campaign.progress';
      requestId: string;
      progress: CampaignProgress;
    }
  | {
      protocolVersion: typeof CAMPAIGN_WORKER_PROTOCOL_VERSION;
      type: 'campaign.result';
      requestId: string;
      result: CampaignResult;
    }
  | {
      protocolVersion: typeof CAMPAIGN_WORKER_PROTOCOL_VERSION;
      type: 'campaign.cancelled';
      requestId: string;
      completedCases: number;
      result: CampaignResult;
    }
  | {
      protocolVersion: typeof CAMPAIGN_WORKER_PROTOCOL_VERSION;
      type: 'campaign.error';
      requestId: string;
      error: { name: string; message: string };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCampaignWorkerRequest(value: unknown): value is CampaignWorkerRequest {
  if (!isRecord(value) || value.protocolVersion !== CAMPAIGN_WORKER_PROTOCOL_VERSION) return false;
  if (typeof value.requestId !== 'string' || value.requestId === '') return false;
  if (value.type === 'campaign.cancel') return true;
  return value.type === 'campaign.run' && isRecord(value.spec);
}

export function isCampaignWorkerResponse(value: unknown): value is CampaignWorkerResponse {
  if (!isRecord(value) || value.protocolVersion !== CAMPAIGN_WORKER_PROTOCOL_VERSION) return false;
  if (typeof value.requestId !== 'string' || value.requestId === '') return false;
  switch (value.type) {
    case 'campaign.progress':
      return isRecord(value.progress);
    case 'campaign.result':
      return isRecord(value.result);
    case 'campaign.cancelled':
      return typeof value.completedCases === 'number' && isRecord(value.result);
    case 'campaign.error':
      return isRecord(value.error);
    default:
      return false;
  }
}
