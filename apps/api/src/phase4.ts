import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createOAuthAttempt, disconnectConnection, revalidateConnection } from './connectionService';
import { publicationIdempotencyKey } from './publishing';
import { createPublicationJob, dispatchPublicationJob, PreflightFailedError, publicationPreflight, reconcilePublicationJob } from './publicationService';
import { accountActivationSchema, manualPublicationSchema, pausePublishingSchema, reschedulePublicationSchema, schedulePublicationSchema } from './phase4Schemas';
import type { Env, Variables } from './types';

const phase4 = new Hono<{ Bindings: Env; Variables: Variables }>();
type Supabase = Variables['supabase'];

async function body<Schema extends z.ZodTypeAny>(c: Context, schema: Schema): Promise<z.output<Schema>> {
  return schema.parse(await c.req.json()) as z.output<Schema>;
}

async function brandWorkspace(supabase: Supabase, brandId: string) {
  const { data, error } = await supabase.from('brands').select('workspace_id').eq('id', brandId).single();
  if (error) throw error;
  return data.workspace_id as string;
}

async function requireWorkspaceRole(supabase: Supabase, workspaceId: string, roles: string[]) {
  const { data, error } = await supabase.rpc('workspace_role', { p_workspace_id: workspaceId });
  if (error) throw error;
  if (!roles.includes(String(data))) throw new Error('Your workspace role does not permit this publishing action.');
  return String(data);
}

async function requireBrandRole(supabase: Supabase, brandId: string, roles: string[]) {
  const workspaceId = await brandWorkspace(supabase, brandId);
  await requireWorkspaceRole(supabase, workspaceId, roles);
  return workspaceId;
}

async function jobAccess(supabase: Supabase, jobId: string) {
  const { data, error } = await supabase.from('publication_jobs').select('*').eq('id', jobId).single();
  if (error) throw error;
  return data;
}

phase4.get('/v4/brands/:brandId/publishing-dashboard', async (c) => {
  const brandId = c.req.param('brandId');
  const supabase = c.get('supabase');
  const workspaceId = await brandWorkspace(supabase, brandId);
  const [connectionsResult, mappingsResult, jobsResult, controlsResult] = await Promise.all([
    supabase.from('platform_connections').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }),
    supabase.from('brand_platform_accounts').select('*, platform_accounts(*)').eq('brand_id', brandId),
    supabase.from('publication_jobs').select('*, publication_snapshots(*), remote_publications(*)').eq('brand_id', brandId).order('scheduled_for', { ascending: false }).limit(100),
    supabase.from('publishing_controls').select('*').eq('workspace_id', workspaceId),
  ]);
  for (const result of [connectionsResult, mappingsResult, jobsResult, controlsResult]) if (result.error) throw result.error;
  return c.json({
    workspace_id: workspaceId,
    connections: connectionsResult.data ?? [],
    accounts: mappingsResult.data ?? [],
    jobs: jobsResult.data ?? [],
    controls: controlsResult.data ?? [],
  });
});

phase4.post('/v4/brands/:brandId/integrations/meta/connect', async (c) => {
  const brandId = c.req.param('brandId');
  await requireBrandRole(c.get('supabase'), brandId, ['owner', 'admin', 'connection_manager']);
  const result = await createOAuthAttempt({ env: c.env, supabase: c.get('supabase'), brandId, userId: c.get('user').id });
  const authorizationUrl = result.authorizationUrl.startsWith('/') ? new URL(result.authorizationUrl, c.req.url).toString() : result.authorizationUrl;
  return c.json({ ...result, authorizationUrl }, 201);
});

phase4.post('/v4/brands/:brandId/platform-accounts/:accountId/activate', async (c) => {
  const input = await body(c, accountActivationSchema);
  const brandId = c.req.param('brandId');
  const supabase = c.get('supabase');
  await requireBrandRole(supabase, brandId, ['owner', 'admin', 'connection_manager']);
  if (input.is_default) await supabase.from('brand_platform_accounts').update({ is_default: false }).eq('brand_id', brandId);
  const { data, error } = await supabase.from('brand_platform_accounts').update({
    is_default: input.is_default,
    publishing_enabled: input.publishing_enabled,
    confirmed_by: c.get('user').id,
    confirmed_at: new Date().toISOString(),
  }).eq('brand_id', brandId).eq('platform_account_id', c.req.param('accountId')).select('*').single();
  if (error) throw error;
  await supabase.from('platform_accounts').update({ status: 'confirmed' }).eq('id', c.req.param('accountId'));
  return c.json(data);
});

phase4.post('/v4/connections/:connectionId/revalidate', async (c) => {
  const supabase = c.get('supabase');
  const { data: connection, error } = await supabase.from('platform_connections').select('workspace_id').eq('id', c.req.param('connectionId')).single();
  if (error) throw error;
  await requireWorkspaceRole(supabase, connection.workspace_id, ['owner', 'admin', 'connection_manager']);
  return c.json(await revalidateConnection(c.env, c.req.param('connectionId')));
});

phase4.post('/v4/connections/:connectionId/disconnect', async (c) => {
  const supabase = c.get('supabase');
  const { data: connection, error } = await supabase.from('platform_connections').select('workspace_id').eq('id', c.req.param('connectionId')).single();
  if (error) throw error;
  await requireWorkspaceRole(supabase, connection.workspace_id, ['owner', 'admin', 'connection_manager']);
  await disconnectConnection(c.env, c.req.param('connectionId'));
  return c.json({ disconnected: true });
});

phase4.post('/v4/content-items/:contentId/publication/preflight', async (c) => {
  const input = await body(c, z.object({
    platform_account_id: z.string().uuid(),
    scheduled_for: z.string().datetime({ offset: true }),
  }));
  const supabase = c.get('supabase');
  const { data: content, error } = await supabase.from('content_items').select('brand_id').eq('id', c.req.param('contentId')).single();
  if (error) throw error;
  await requireBrandRole(supabase, content.brand_id, ['owner', 'admin', 'publisher']);
  const detail = await publicationPreflight({ supabase, contentId: c.req.param('contentId'), platformAccountId: input.platform_account_id, scheduledFor: input.scheduled_for });
  return c.json({ ...detail.preflight, destination: { id: detail.account.id, username: detail.account.username }, content_version_id: detail.version.id });
});

phase4.post('/v4/content-items/:contentId/publications', async (c) => {
  const input = await body(c, schedulePublicationSchema);
  const supabase = c.get('supabase');
  const { data: content, error } = await supabase.from('content_items').select('brand_id').eq('id', c.req.param('contentId')).single();
  if (error) throw error;
  await requireBrandRole(supabase, content.brand_id, ['owner', 'admin', 'publisher']);
  try {
    const job = await createPublicationJob({
      supabase, userId: c.get('user').id, contentId: c.req.param('contentId'),
      platformAccountId: input.platform_account_id, scheduledFor: input.scheduled_for,
      brandTimezone: input.brand_timezone, localScheduledTime: input.local_scheduled_time,
    });
    return c.json(job, 201);
  } catch (publicationError) {
    if (publicationError instanceof PreflightFailedError) return c.json({ error: publicationError.message, preflight: publicationError.result }, 409);
    throw publicationError;
  }
});

phase4.post('/v4/content-items/:contentId/publications/publish-now', async (c) => {
  const input = await body(c, z.object({ platform_account_id: z.string().uuid(), brand_timezone: z.string().default('UTC') }));
  const supabase = c.get('supabase');
  const { data: content, error } = await supabase.from('content_items').select('brand_id').eq('id', c.req.param('contentId')).single();
  if (error) throw error;
  await requireBrandRole(supabase, content.brand_id, ['owner', 'admin', 'publisher']);
  try {
    const scheduledFor = new Date(Date.now() + 3_000).toISOString();
    const job = await createPublicationJob({
      supabase, userId: c.get('user').id, contentId: c.req.param('contentId'),
      platformAccountId: input.platform_account_id, scheduledFor,
      brandTimezone: input.brand_timezone, localScheduledTime: 'Publish now',
    }) as Record<string, any>;
    const result = await dispatchPublicationJob(c.env, job.id);
    return c.json({ job, dispatch: result }, 201);
  } catch (publicationError) {
    if (publicationError instanceof PreflightFailedError) return c.json({ error: publicationError.message, preflight: publicationError.result }, 409);
    throw publicationError;
  }
});

phase4.get('/v4/publication-jobs/:jobId', async (c) => {
  const supabase = c.get('supabase');
  const job = await jobAccess(supabase, c.req.param('jobId'));
  const [snapshot, attempts, remote, events] = await Promise.all([
    supabase.from('publication_snapshots').select('*').eq('id', job.publication_snapshot_id).single(),
    supabase.from('publication_attempts').select('*').eq('publication_job_id', job.id).order('attempt_number'),
    supabase.from('remote_publications').select('*').eq('publication_job_id', job.id).maybeSingle(),
    supabase.from('publication_events').select('*').eq('publication_job_id', job.id).order('created_at'),
  ]);
  for (const result of [snapshot, attempts, remote, events]) if (result.error) throw result.error;
  return c.json({ job, snapshot: snapshot.data, attempts: attempts.data ?? [], remote: remote.data, events: events.data ?? [] });
});

phase4.patch('/v4/publication-jobs/:jobId/reschedule', async (c) => {
  const input = await body(c, reschedulePublicationSchema);
  const supabase = c.get('supabase');
  const job = await jobAccess(supabase, c.req.param('jobId'));
  await requireWorkspaceRole(supabase, job.workspace_id, ['owner', 'admin', 'publisher']);
  if (!['scheduled', 'ready', 'preflight_failed', 'retry_waiting'].includes(job.status)) return c.json({ error: 'This job can no longer be rescheduled safely.' }, 409);
  const { data: snapshot, error } = await supabase.from('publication_snapshots').select('*').eq('id', job.publication_snapshot_id).single();
  if (error) throw error;
  const idempotencyKey = await publicationIdempotencyKey({
    workspaceId: job.workspace_id,
    accountId: snapshot.platform_account_id,
    contentVersionId: snapshot.content_version_id,
    materialRevision: snapshot.material_revision,
    scheduledFor: input.scheduled_for,
  });
  const { data, error: updateError } = await supabase.from('publication_jobs').update({
    scheduled_for: input.scheduled_for,
    brand_timezone: input.brand_timezone,
    local_scheduled_time: input.local_scheduled_time,
    idempotency_key: idempotencyKey,
    status: 'scheduled',
    next_attempt_at: null,
    safe_error_message: '',
  }).eq('id', job.id).select('*').single();
  if (updateError) throw updateError;
  return c.json(data);
});

phase4.post('/v4/publication-jobs/:jobId/cancel', async (c) => {
  const supabase = c.get('supabase');
  const job = await jobAccess(supabase, c.req.param('jobId'));
  await requireWorkspaceRole(supabase, job.workspace_id, ['owner', 'admin', 'publisher']);
  if (['published', 'verified', 'completed', 'manual_published'].includes(job.status)) return c.json({ error: 'The content may already be public and cannot be treated as a cancellable job.' }, 409);
  const { data, error } = await supabase.from('publication_jobs').update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: c.get('user').id, lock_token: null, locked_at: null }).eq('id', job.id).select('*').single();
  if (error) throw error;
  return c.json(data);
});

phase4.post('/v4/publication-jobs/:jobId/retry', async (c) => {
  const supabase = c.get('supabase');
  const job = await jobAccess(supabase, c.req.param('jobId'));
  await requireWorkspaceRole(supabase, job.workspace_id, ['owner', 'admin', 'publisher']);
  if (job.status === 'verification_uncertain') return c.json({ error: 'Reconcile this job before retrying to avoid a duplicate publication.' }, 409);
  if (['completed', 'verified', 'published', 'manual_published', 'cancelled'].includes(job.status)) return c.json({ error: 'This publication is not retryable.' }, 409);
  await supabase.from('publication_jobs').update({ status: 'retry_waiting', next_attempt_at: new Date().toISOString(), safe_error_message: '' }).eq('id', job.id);
  return c.json(await dispatchPublicationJob(c.env, job.id));
});

phase4.post('/v4/publication-jobs/:jobId/reconcile', async (c) => {
  const supabase = c.get('supabase');
  const job = await jobAccess(supabase, c.req.param('jobId'));
  await requireWorkspaceRole(supabase, job.workspace_id, ['owner', 'admin', 'publisher']);
  return c.json(await reconcilePublicationJob(c.env, job.id));
});

phase4.post('/v4/publication-jobs/:jobId/mark-manual', async (c) => {
  const input = await body(c, manualPublicationSchema);
  const supabase = c.get('supabase');
  const job = await jobAccess(supabase, c.req.param('jobId'));
  await requireWorkspaceRole(supabase, job.workspace_id, ['owner', 'admin', 'publisher']);
  const { data, error } = await supabase.from('publication_jobs').update({
    status: 'manual_published', manual_published_at: new Date().toISOString(), manual_published_by: c.get('user').id,
    safe_error_message: input.note,
  }).eq('id', job.id).select('*').single();
  if (error) throw error;
  await supabase.from('publication_events').insert({ publication_job_id: job.id, previous_status: job.status, next_status: 'manual_published', actor_id: c.get('user').id, source: 'user', reason: input.note, metadata: { remote_url: input.remote_url } });
  return c.json(data);
});

phase4.post('/v4/workspaces/:workspaceId/publishing/pause', async (c) => {
  const input = await body(c, pausePublishingSchema);
  const workspaceId = c.req.param('workspaceId');
  const supabase = c.get('supabase');
  await requireWorkspaceRole(supabase, workspaceId, ['owner', 'admin', 'publisher']);
  const existing = await supabase.from('publishing_controls').select('*').eq('workspace_id', workspaceId);
  if (existing.error) throw existing.error;
  const match = (existing.data ?? []).find((row) => (row.brand_id ?? null) === (input.brand_id ?? null) && (row.platform_account_id ?? null) === (input.platform_account_id ?? null));
  const payload = { workspace_id: workspaceId, brand_id: input.brand_id ?? null, platform_account_id: input.platform_account_id ?? null, publishing_paused: true, pause_reason: input.reason, paused_by: c.get('user').id, paused_at: new Date().toISOString(), resumed_at: null };
  const result = match
    ? await supabase.from('publishing_controls').update(payload).eq('id', match.id).select('*').single()
    : await supabase.from('publishing_controls').insert(payload).select('*').single();
  if (result.error) throw result.error;
  return c.json(result.data);
});

phase4.post('/v4/publishing-controls/:controlId/resume', async (c) => {
  const supabase = c.get('supabase');
  const { data: control, error } = await supabase.from('publishing_controls').select('*').eq('id', c.req.param('controlId')).single();
  if (error) throw error;
  await requireWorkspaceRole(supabase, control.workspace_id, ['owner', 'admin', 'publisher']);
  const { data, error: updateError } = await supabase.from('publishing_controls').update({ publishing_paused: false, pause_reason: '', resumed_at: new Date().toISOString() }).eq('id', control.id).select('*').single();
  if (updateError) throw updateError;
  return c.json(data);
});

export default phase4;
