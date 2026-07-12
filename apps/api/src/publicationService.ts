import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAccessToken } from './connectionService';
import { createServiceClient } from './db';
import { publishingProvider, ProviderError, type ProviderSnapshot } from './providers';
import { preflightPublication, publicationIdempotencyKey, publicationSnapshotChecksum, retryDecision, safeCaption } from './publishing';
import { sha256Hex } from './crypto';
import type { Env } from './types';

type Row = Record<string, any>;

function nestedAsset(value: unknown): Row | null {
  if (Array.isArray(value)) return (value[0] ?? null) as Row | null;
  return value && typeof value === 'object' ? value as Row : null;
}

async function workspaceForBrand(supabase: SupabaseClient, brandId: string) {
  const { data, error } = await supabase.from('brands').select('workspace_id').eq('id', brandId).single();
  if (error) throw error;
  return data.workspace_id as string;
}

export async function publicationPreflight(input: {
  supabase: SupabaseClient;
  contentId: string;
  platformAccountId: string;
  scheduledFor: string;
  dispatchCheck?: boolean;
}) {
  const { supabase, contentId, platformAccountId } = input;
  const { data: content, error: contentError } = await supabase.from('content_items').select('*').eq('id', contentId).single();
  if (contentError) throw contentError;
  const workspaceId = await workspaceForBrand(supabase, content.brand_id);
  const [versionResult, mappingResult, accountResult, approvalsResult, tasksResult, threadsResult, attachmentsResult, controlsResult] = await Promise.all([
    supabase.from('content_versions').select('*').eq('content_item_id', contentId).order('version_number', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('brand_platform_accounts').select('*').eq('brand_id', content.brand_id).eq('platform_account_id', platformAccountId).maybeSingle(),
    supabase.from('platform_accounts').select('*').eq('id', platformAccountId).single(),
    supabase.from('approval_requests').select('*').eq('content_item_id', contentId),
    supabase.from('tasks').select('*').eq('content_item_id', contentId),
    supabase.from('comment_threads').select('*').eq('content_item_id', contentId),
    supabase.from('content_assets').select('role,position,required,assets(*)').eq('content_item_id', contentId).eq('required', true).order('position'),
    supabase.from('publishing_controls').select('*').eq('workspace_id', workspaceId).eq('publishing_paused', true),
  ]);
  for (const result of [versionResult, mappingResult, accountResult, approvalsResult, tasksResult, threadsResult, attachmentsResult, controlsResult]) if (result.error) throw result.error;
  if (!versionResult.data) throw new Error('Content has no version to publish.');
  const { data: connection, error: connectionError } = await supabase.from('platform_connections').select('*').eq('id', accountResult.data.connection_id).single();
  if (connectionError) throw connectionError;
  const campaignResult = content.campaign_id
    ? await supabase.from('campaigns').select('*').eq('id', content.campaign_id).single()
    : { data: null, error: null };
  if (campaignResult.error) throw campaignResult.error;

  const attachments = (attachmentsResult.data ?? []).map((item: Row) => ({ ...item, asset: nestedAsset(item.assets) })).filter((item: Row) => item.asset);
  const approvals = approvalsResult.data ?? [];
  const currentRequired = approvals.filter((approval: Row) => approval.required && approval.material_revision === content.material_revision && approval.content_version_id === versionResult.data.id);
  const controls = controlsResult.data ?? [];
  const publishingPaused = controls.some((control: Row) =>
    (!control.brand_id || control.brand_id === content.brand_id)
    && (!control.platform_account_id || control.platform_account_id === platformAccountId));
  const qualityErrors = Array.isArray(content.quality_flags)
    ? content.quality_flags.filter((flag: Row) => flag.severity === 'error').length
    : 0;
  const offer = campaignResult.data?.offer_details as { valid_until?: string } | undefined;
  const scheduleForCheck = input.dispatchCheck ? new Date().toISOString() : input.scheduledFor;
  const preflight = preflightPublication({
    connectionHealthy: ['connected', 'healthy'].includes(connection.status) && ['confirmed', 'healthy'].includes(accountResult.data.status),
    publishingEnabled: Boolean(mappingResult.data?.publishing_enabled),
    publishingPaused,
    contentWorkflowStatus: content.workflow_status,
    currentMaterialRevision: content.material_revision,
    versionMaterialRevision: Number((versionResult.data.snapshot as Row | null)?.material_revision ?? content.material_revision),
    requiredApprovals: currentRequired.length,
    approvedCurrentApprovals: currentRequired.filter((approval: Row) => approval.status === 'approved').length,
    staleApprovals: approvals.filter((approval: Row) => approval.status === 'stale').length,
    qualityErrors,
    blockingTasks: (tasksResult.data ?? []).filter((task: Row) => task.blocks_completion && !['done', 'cancelled'].includes(task.status)).length,
    blockingThreads: (threadsResult.data ?? []).filter((thread: Row) => thread.blocks_approval && thread.status !== 'resolved').length,
    campaignStatus: campaignResult.data?.status,
    campaignEnd: campaignResult.data?.end_date,
    offerValidUntil: offer?.valid_until,
    assets: attachments.map((item: Row) => ({
      role: item.role,
      position: item.position,
      mimeType: item.asset.mime_type,
      approved: item.asset.approved,
      rightsStatus: item.asset.rights_status,
      expiresAt: item.asset.expires_at,
      sizeBytes: Number(item.asset.size_bytes ?? 0),
      width: item.asset.width,
      height: item.asset.height,
      durationSeconds: item.asset.duration_seconds,
    })),
    format: content.format,
    scheduledFor: scheduleForCheck,
    capabilities: accountResult.data.capabilities ?? {},
  });
  return {
    preflight,
    workspaceId,
    content,
    version: versionResult.data,
    mapping: mappingResult.data,
    account: accountResult.data,
    connection,
    campaign: campaignResult.data,
    approvals: currentRequired,
    attachments,
  };
}

export class PreflightFailedError extends Error {
  constructor(public readonly result: Awaited<ReturnType<typeof publicationPreflight>>['preflight']) {
    super('Publication preflight failed.');
  }
}

export async function createPublicationJob(input: {
  supabase: SupabaseClient;
  userId: string;
  contentId: string;
  platformAccountId: string;
  scheduledFor: string;
  brandTimezone: string;
  localScheduledTime: string;
}) {
  const detail = await publicationPreflight({
    supabase: input.supabase,
    contentId: input.contentId,
    platformAccountId: input.platformAccountId,
    scheduledFor: input.scheduledFor,
  });
  if (!detail.preflight.eligible) throw new PreflightFailedError(detail.preflight);
  const media = await Promise.all(detail.attachments.map(async (attachment: Row) => ({
    asset_id: attachment.asset.id,
    role: attachment.role,
    position: attachment.position,
    storage_bucket: attachment.asset.storage_bucket,
    storage_path: attachment.asset.storage_path,
    mime_type: attachment.asset.mime_type,
    size_bytes: Number(attachment.asset.size_bytes ?? 0),
    checksum: await sha256Hex(JSON.stringify({
      id: attachment.asset.id,
      path: attachment.asset.storage_path,
      size: attachment.asset.size_bytes,
      mime: attachment.asset.mime_type,
      updated: attachment.asset.updated_at,
    })),
  })));
  const snapshot = {
    content: {
      id: detail.content.id,
      version_id: detail.version.id,
      material_revision: detail.content.material_revision,
      title: detail.content.title,
      hook: detail.content.hook,
      caption: detail.content.caption,
      cta: detail.content.cta,
      hashtags: detail.content.hashtags ?? [],
      visual_brief: detail.content.visual_brief,
      format: detail.content.format,
      scheduled_date: detail.content.scheduled_date,
    },
    campaign: detail.campaign ? {
      id: detail.campaign.id,
      name: detail.campaign.name,
      status: detail.campaign.status,
      end_date: detail.campaign.end_date,
      offer_details: detail.campaign.offer_details,
    } : null,
    destination: {
      platform_account_id: detail.account.id,
      provider_account_id: detail.account.provider_account_id,
      username: detail.account.username,
      provider: detail.connection.provider,
    },
    media,
  };
  const idempotencyKey = await publicationIdempotencyKey({
    workspaceId: detail.workspaceId,
    accountId: detail.account.id,
    contentVersionId: detail.version.id,
    materialRevision: detail.content.material_revision,
    scheduledFor: input.scheduledFor,
  });
  const { data: existing, error: existingError } = await input.supabase.from('publication_jobs').select('*, publication_snapshots(*)').eq('idempotency_key', idempotencyKey).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing;
  const { data: storedSnapshot, error: snapshotError } = await input.supabase.from('publication_snapshots').insert({
    workspace_id: detail.workspaceId,
    brand_id: detail.content.brand_id,
    campaign_id: detail.content.campaign_id,
    content_item_id: detail.content.id,
    content_version_id: detail.version.id,
    material_revision: detail.content.material_revision,
    platform_account_id: detail.account.id,
    snapshot,
    asset_checksums: media.map((item) => ({ asset_id: item.asset_id, checksum: item.checksum })),
    approval_snapshot: detail.approvals,
    preflight_snapshot: detail.preflight,
    snapshot_checksum: await publicationSnapshotChecksum(snapshot),
    created_by: input.userId,
  }).select('*').single();
  if (snapshotError) throw snapshotError;
  const { data: job, error: jobError } = await input.supabase.from('publication_jobs').insert({
    workspace_id: detail.workspaceId,
    brand_id: detail.content.brand_id,
    publication_snapshot_id: storedSnapshot.id,
    scheduled_for: input.scheduledFor,
    brand_timezone: input.brandTimezone,
    local_scheduled_time: input.localScheduledTime,
    status: 'scheduled',
    idempotency_key: idempotencyKey,
    created_by: input.userId,
  }).select('*').single();
  if (jobError) throw jobError;
  await input.supabase.from('publication_events').insert({
    publication_job_id: job.id,
    next_status: 'scheduled',
    actor_id: input.userId,
    source: 'user',
    reason: 'Publication scheduled.',
  });
  return { ...job, publication_snapshots: storedSnapshot };
}

async function mediaForProvider(service: SupabaseClient, snapshot: Row): Promise<ProviderSnapshot> {
  const media = [] as ProviderSnapshot['media'];
  for (const item of snapshot.media as Row[]) {
    const signed = await service.storage.from(item.storage_bucket).createSignedUrl(item.storage_path, 30 * 60);
    if (signed.error || !signed.data?.signedUrl) throw new ProviderError('An approved asset could not be delivered to the provider.', 'asset', 'SIGNED_URL');
    media.push({ url: signed.data.signedUrl, mimeType: item.mime_type, role: item.role, position: item.position });
  }
  media.sort((a, b) => a.position - b.position);
  return { format: snapshot.content.format, caption: safeCaption(snapshot.content), media } as ProviderSnapshot;
}

async function setRetry(service: SupabaseClient, job: Row, attempt: Row | null, error: ProviderError) {
  const decision = retryDecision(error.category, Number(job.attempt_count));
  const status = error.unknownResult ? 'verification_uncertain' : decision.retryable ? 'retry_waiting' : decision.terminalStatus;
  if (attempt) await service.from('publication_attempts').update({
    provider_stage: 'failed',
    error_category: error.category,
    provider_error_code: error.providerCode,
    safe_error_message: error.message,
    completed_at: new Date().toISOString(),
  }).eq('id', attempt.id);
  await service.from('publication_jobs').update({
    status,
    next_attempt_at: error.unknownResult ? null : decision.nextAttemptAt,
    last_error_category: error.category,
    safe_error_message: error.message,
    lock_token: null,
    locked_at: null,
  }).eq('id', job.id);
  if (error.category === 'authorization') {
    const { data: snapshot } = await service.from('publication_snapshots').select('platform_account_id').eq('id', job.publication_snapshot_id).single();
    if (snapshot) {
      const { data: account } = await service.from('platform_accounts').select('connection_id').eq('id', snapshot.platform_account_id).single();
      if (account) await service.from('platform_connections').update({ status: 'reauthorization_required', reauthorization_required_at: new Date().toISOString() }).eq('id', account.connection_id);
    }
  }
}

async function completeVerified(service: SupabaseClient, input: { job: Row; accountId: string; attempt: Row; verification: Row }) {
  await service.from('remote_publications').upsert({
    publication_job_id: input.job.id,
    platform_account_id: input.accountId,
    remote_media_id: input.verification.mediaId,
    permalink: input.verification.permalink,
    published_at: input.verification.publishedAt,
    verified_at: new Date().toISOString(),
    remote_snapshot: input.verification.remoteSnapshot,
  }, { onConflict: 'publication_job_id' });
  await service.from('publication_attempts').update({
    provider_stage: 'verified',
    remote_media_id: input.verification.mediaId,
    result: input.verification,
    completed_at: new Date().toISOString(),
  }).eq('id', input.attempt.id);
  await service.from('publication_jobs').update({ status: 'verified', safe_error_message: '', next_attempt_at: null }).eq('id', input.job.id);
  await service.from('publication_jobs').update({ status: 'completed', lock_token: null, locked_at: null }).eq('id', input.job.id);
  await service.from('platform_accounts').update({ publishing_tested_at: new Date().toISOString(), status: 'healthy' }).eq('id', input.accountId);
}

export async function dispatchPublicationJob(env: Env, jobId: string) {
  const service = createServiceClient(env);
  const lockToken = crypto.randomUUID();
  const { data: claimed, error: claimError } = await service.rpc('claim_publication_job', { p_job_id: jobId, p_lock_token: lockToken });
  if (claimError) throw claimError;
  if (!claimed) return { claimed: false };
  const { data: job, error: jobError } = await service.from('publication_jobs').select('*').eq('id', jobId).single();
  if (jobError) throw jobError;
  const { data: storedSnapshot, error: snapshotError } = await service.from('publication_snapshots').select('*').eq('id', job.publication_snapshot_id).single();
  if (snapshotError) throw snapshotError;
  const snapshot = storedSnapshot.snapshot as Row;
  const { data: account, error: accountError } = await service.from('platform_accounts').select('*').eq('id', storedSnapshot.platform_account_id).single();
  if (accountError) throw accountError;
  const { data: connection, error: connectionError } = await service.from('platform_connections').select('*').eq('id', account.connection_id).single();
  if (connectionError) throw connectionError;
  const priorResult = await service.from('publication_attempts').select('*').eq('publication_job_id', jobId).order('attempt_number', { ascending: false }).limit(1).maybeSingle();
  if (priorResult.error) throw priorResult.error;
  const { data: attempt, error: attemptError } = await service.from('publication_attempts').insert({
    publication_job_id: jobId,
    attempt_number: job.attempt_count,
    provider_stage: 'preflight',
  }).select('*').single();
  if (attemptError) throw attemptError;

  try {
    const detail = await publicationPreflight({
      supabase: service,
      contentId: storedSnapshot.content_item_id,
      platformAccountId: storedSnapshot.platform_account_id,
      scheduledFor: job.scheduled_for,
      dispatchCheck: true,
    });
    if (!detail.preflight.eligible) {
      await service.from('publication_attempts').update({ provider_stage: 'preflight_failed', result: detail.preflight, completed_at: new Date().toISOString() }).eq('id', attempt.id);
      await service.from('publication_jobs').update({ status: 'preflight_failed', safe_error_message: detail.preflight.errors.map((issue) => issue.message).join(' '), lock_token: null, locked_at: null }).eq('id', jobId);
      return { claimed: true, preflight: detail.preflight };
    }
    const credential = await loadAccessToken(env, connection.id);
    const provider = publishingProvider(env);
    const existingRemote = await service.from('remote_publications').select('*').eq('publication_job_id', jobId).maybeSingle();
    if (existingRemote.error) throw existingRemote.error;
    if (existingRemote.data) {
      const verification = await provider.verify(existingRemote.data.remote_media_id, credential.accessToken);
      if (verification.verified) await completeVerified(service, { job, accountId: account.id, attempt, verification });
      return { claimed: true, verification };
    }

    let containerId = priorResult.data?.remote_container_id as string | undefined;
    let mediaId = priorResult.data?.remote_media_id as string | undefined;
    if (mediaId) {
      const verification = await provider.verify(mediaId, credential.accessToken);
      if (verification.verified) {
        await completeVerified(service, { job, accountId: account.id, attempt, verification });
        return { claimed: true, verification };
      }
      throw new ProviderError('The remote publication could not yet be verified.', 'transient', 'VERIFY_PENDING');
    }

    if (!containerId) {
      const creation = await provider.createMedia(account.provider_account_id, credential.accessToken, await mediaForProvider(service, snapshot));
      containerId = creation.containerId;
      await service.from('publication_attempts').update({ provider_stage: 'remote_media_created', remote_container_id: containerId, result: { child_container_ids: creation.childContainerIds ?? [] } }).eq('id', attempt.id);
      await service.from('publication_jobs').update({ status: creation.processingRequired ? 'remote_processing' : 'remote_media_created' }).eq('id', jobId);
      if (creation.processingRequired) {
        const processing = await provider.checkProcessing(containerId, credential.accessToken);
        if (processing.failed) throw new ProviderError(`Remote media processing failed: ${processing.status}.`, 'remote_rejection', processing.status);
        if (!processing.ready) {
          await service.from('publication_attempts').update({ provider_stage: 'remote_processing', remote_container_id: containerId, result: processing, completed_at: new Date().toISOString() }).eq('id', attempt.id);
          await service.from('publication_jobs').update({ status: 'retry_waiting', next_attempt_at: new Date(Date.now() + 60_000).toISOString(), lock_token: null, locked_at: null }).eq('id', jobId);
          return { claimed: true, processing };
        }
      }
    } else {
      const processing = await provider.checkProcessing(containerId, credential.accessToken);
      if (processing.failed) throw new ProviderError(`Remote media processing failed: ${processing.status}.`, 'remote_rejection', processing.status);
      if (!processing.ready) {
        await service.from('publication_attempts').update({ provider_stage: 'remote_processing', remote_container_id: containerId, result: processing, completed_at: new Date().toISOString() }).eq('id', attempt.id);
        await service.from('publication_jobs').update({ status: 'retry_waiting', next_attempt_at: new Date(Date.now() + 60_000).toISOString(), lock_token: null, locked_at: null }).eq('id', jobId);
        return { claimed: true, processing };
      }
    }

    await service.from('publication_jobs').update({ status: 'publish_requested' }).eq('id', jobId);
    const published = await provider.publish(account.provider_account_id, credential.accessToken, containerId);
    mediaId = published.mediaId;
    await service.from('publication_attempts').update({ provider_stage: 'published', remote_container_id: containerId, remote_media_id: mediaId }).eq('id', attempt.id);
    await service.from('publication_jobs').update({ status: 'published' }).eq('id', jobId);
    const verification = await provider.verify(mediaId, credential.accessToken);
    if (!verification.verified) throw new ProviderError('The provider accepted publication but verification is still pending.', 'transient', 'VERIFY_PENDING');
    await completeVerified(service, { job, accountId: account.id, attempt, verification });
    return { claimed: true, verification };
  } catch (dispatchError) {
    const providerError = dispatchError instanceof ProviderError
      ? dispatchError
      : new ProviderError(dispatchError instanceof Error ? dispatchError.message : 'Publishing failed.', 'transient', 'INTERNAL');
    await setRetry(service, job, attempt, providerError);
    return { claimed: true, error: providerError.message, category: providerError.category };
  }
}

export async function dispatchDuePublications(env: Env) {
  const service = createServiceClient(env);
  await service.rpc('expire_oauth_attempts');
  const now = new Date().toISOString();
  const { data, error } = await service.from('publication_jobs').select('*')
    .in('status', ['scheduled', 'ready', 'retry_waiting'])
    .order('scheduled_for').limit(40);
  if (error) throw error;
  const due = (data ?? []).filter((job: Row) => new Date(job.next_attempt_at ?? job.scheduled_for).toISOString() <= now);
  const results = [];
  for (const job of due) results.push(await dispatchPublicationJob(env, job.id));
  return { checked: data?.length ?? 0, dispatched: due.length, results };
}

export async function reconcilePublicationJob(env: Env, jobId: string) {
  const service = createServiceClient(env);
  const { data: job, error } = await service.from('publication_jobs').select('*').eq('id', jobId).single();
  if (error) throw error;
  const { data: snapshot, error: snapshotError } = await service.from('publication_snapshots').select('*').eq('id', job.publication_snapshot_id).single();
  if (snapshotError) throw snapshotError;
  const { data: account, error: accountError } = await service.from('platform_accounts').select('*').eq('id', snapshot.platform_account_id).single();
  if (accountError) throw accountError;
  const attemptResult = await service.from('publication_attempts').select('*').eq('publication_job_id', jobId).not('remote_media_id', 'is', null).order('attempt_number', { ascending: false }).limit(1).maybeSingle();
  if (attemptResult.error) throw attemptResult.error;
  if (!attemptResult.data?.remote_media_id) return { reconciled: false, reason: 'No remote media ID is available. Automatic retry remains blocked to avoid duplication.' };
  const { data: connection, error: connectionError } = await service.from('platform_connections').select('id').eq('id', account.connection_id).single();
  if (connectionError) throw connectionError;
  if (!connection) throw new ProviderError('The destination connection no longer exists.', 'authorization', 'CONNECTION_MISSING');
  const credential = await loadAccessToken(env, connection.id);
  const verification = await publishingProvider(env).verify(attemptResult.data.remote_media_id, credential.accessToken);
  if (verification.verified) {
    await completeVerified(service, { job, accountId: account.id, attempt: attemptResult.data, verification });
    await service.from('publication_events').insert({ publication_job_id: jobId, previous_status: job.status, next_status: 'completed', source: 'reconciliation', reason: 'Remote publication verified.' });
  }
  return { reconciled: verification.verified, verification };
}
