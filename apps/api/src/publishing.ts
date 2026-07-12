import { sha256Hex } from './crypto';

export type PreflightIssue = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
};

export type PreflightInput = {
  connectionHealthy: boolean;
  publishingEnabled: boolean;
  publishingPaused: boolean;
  contentWorkflowStatus: string;
  currentMaterialRevision: number;
  versionMaterialRevision: number;
  requiredApprovals: number;
  approvedCurrentApprovals: number;
  staleApprovals: number;
  qualityErrors: number;
  blockingTasks: number;
  blockingThreads: number;
  campaignStatus?: string | null;
  campaignEnd?: string | null;
  offerValidUntil?: string | null;
  assets: Array<{
    role: string;
    position: number;
    mimeType: string;
    approved: boolean;
    rightsStatus: string;
    expiresAt?: string | null;
    sizeBytes?: number;
    width?: number | null;
    height?: number | null;
    durationSeconds?: number | null;
  }>;
  format: 'static' | 'carousel' | 'reel' | 'story';
  scheduledFor: string;
  now?: Date;
  capabilities: Record<string, boolean | number | null | undefined>;
};

const today = (date: Date) => date.toISOString().slice(0, 10);

export function preflightPublication(input: PreflightInput) {
  const now = input.now ?? new Date();
  const issues: PreflightIssue[] = [];
  const error = (code: string, message: string) => issues.push({ code, severity: 'error', message });
  const warning = (code: string, message: string) => issues.push({ code, severity: 'warning', message });

  if (!input.connectionHealthy) error('CONNECTION_UNHEALTHY', 'The destination connection is not healthy.');
  if (!input.publishingEnabled) error('PUBLISHING_DISABLED', 'Publishing has not been enabled for this destination.');
  if (input.publishingPaused) error('PUBLISHING_PAUSED', 'Publishing is paused for this workspace, brand or account.');
  if (!['approved', 'ready_to_publish'].includes(input.contentWorkflowStatus)) error('CONTENT_NOT_APPROVED', 'Content is not in an approved publishing state.');
  if (input.versionMaterialRevision !== input.currentMaterialRevision) error('STALE_VERSION', 'The selected content version is not the current material revision.');
  if (input.requiredApprovals < 1) error('APPROVAL_REQUIRED', 'At least one required human approval must exist.');
  if (input.approvedCurrentApprovals < input.requiredApprovals) error('APPROVAL_INCOMPLETE', 'Required approvals are not complete for this revision.');
  if (input.staleApprovals > 0) error('STALE_APPROVAL', 'One or more approvals became stale after a material edit.');
  if (input.qualityErrors > 0) error('QUALITY_ERROR', 'Error-level quality checks must be resolved.');
  if (input.blockingTasks > 0) error('BLOCKING_TASK', 'Blocking operational tasks remain open.');
  if (input.blockingThreads > 0) error('BLOCKING_REVIEW', 'Blocking review threads remain unresolved.');
  if (input.campaignStatus && ['cancelled', 'archived'].includes(input.campaignStatus)) error('CAMPAIGN_INACTIVE', 'The campaign is cancelled or archived.');

  const schedule = new Date(input.scheduledFor);
  if (Number.isNaN(schedule.getTime())) error('INVALID_SCHEDULE', 'The scheduled time is invalid.');
  else if (schedule.getTime() < now.getTime() - 60_000) error('SCHEDULE_IN_PAST', 'The scheduled time is in the past.');
  const scheduleDate = Number.isNaN(schedule.getTime()) ? today(now) : today(schedule);
  if (input.campaignEnd && scheduleDate > input.campaignEnd) error('CAMPAIGN_EXPIRED', 'The campaign ends before the scheduled publication.');
  if (input.offerValidUntil && scheduleDate > input.offerValidUntil) error('OFFER_EXPIRED', 'The campaign offer expires before the scheduled publication.');

  const expectedCapability = input.format === 'static' ? 'image_post' : input.format;
  if (input.capabilities[expectedCapability] !== true) error('FORMAT_UNSUPPORTED', `${input.format} publishing is not enabled for this account.`);
  if (!input.assets.length) error('ASSET_MISSING', 'At least one approved publishing asset is required.');
  for (const asset of input.assets) {
    if (!asset.approved) error('ASSET_UNAPPROVED', `The ${asset.role} asset is not approved.`);
    if (!['owned', 'licensed'].includes(asset.rightsStatus)) error('ASSET_RIGHTS', `The ${asset.role} asset does not have publishable usage rights.`);
    if (asset.expiresAt && asset.expiresAt < scheduleDate) error('ASSET_EXPIRED', `The ${asset.role} asset rights expire before publication.`);
    if (!['image/jpeg', 'image/png', 'video/mp4'].includes(asset.mimeType)) error('ASSET_TYPE', `Unsupported publishing asset type: ${asset.mimeType}.`);
    if ((asset.sizeBytes ?? 0) <= 0) warning('ASSET_SIZE_UNKNOWN', `The ${asset.role} asset size has not been confirmed.`);
  }
  if (input.format === 'static' && input.assets.length !== 1) error('STATIC_ASSET_COUNT', 'A static publication must contain exactly one asset.');
  if (input.format === 'carousel') {
    const max = typeof input.capabilities.max_carousel_items === 'number' ? input.capabilities.max_carousel_items : 10;
    if (input.assets.length < 2 || input.assets.length > max) error('CAROUSEL_COUNT', `Carousel requires 2 to ${max} ordered assets.`);
  }
  if (input.format === 'reel') {
    if (input.assets.length !== 1 || input.assets[0]?.mimeType !== 'video/mp4') error('REEL_ASSET', 'A Reel requires exactly one MP4 video asset.');
  }
  if (input.format === 'story') warning('STORY_LIMITATION', 'Story publishing must be confirmed in the provider capability spike.');

  return {
    eligible: !issues.some((issue) => issue.severity === 'error'),
    errors: issues.filter((issue) => issue.severity === 'error'),
    warnings: issues.filter((issue) => issue.severity === 'warning'),
    checked_at: now.toISOString(),
  };
}

export async function publicationIdempotencyKey(input: {
  workspaceId: string;
  accountId: string;
  contentVersionId: string;
  materialRevision: number;
  scheduledFor: string;
}) {
  return sha256Hex([input.workspaceId, input.accountId, input.contentVersionId, input.materialRevision, input.scheduledFor].join(':'));
}

export async function publicationSnapshotChecksum(snapshot: unknown) {
  return sha256Hex(JSON.stringify(snapshot));
}

export type DeliveryErrorCategory = 'transient' | 'authorization' | 'content' | 'asset' | 'unknown_result' | 'remote_rejection';

export function retryDecision(category: DeliveryErrorCategory, attemptCount: number, now = new Date()) {
  const retryable = ['transient', 'unknown_result'].includes(category) && attemptCount < 5;
  const minutes = Math.min(2 ** Math.max(attemptCount - 1, 0), 30);
  return {
    retryable,
    nextAttemptAt: retryable ? new Date(now.getTime() + minutes * 60_000).toISOString() : null,
    terminalStatus: category === 'authorization'
      ? 'permission_failure'
      : category === 'asset'
        ? 'asset_failure'
        : category === 'content' || category === 'remote_rejection'
          ? 'remote_rejection'
          : 'manual_action_required',
  };
}

export function safeCaption(snapshot: { caption?: string; hashtags?: string[]; cta?: string }) {
  return [snapshot.caption?.trim(), snapshot.cta?.trim(), snapshot.hashtags?.join(' ')].filter(Boolean).join('\n\n');
}
