import { createServiceClient } from './db';
import { assignGrowthVariant, sanitizeAttribution, sanitizeGrowthProperties, validReferralCode } from './growth';
import { requirePlatformOperator } from './reliabilityService';
import type { Env } from './types';

type ServiceClient = ReturnType<typeof createServiceClient>;

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomCode(length = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

export async function growthDashboard(env: Env, userId: string) {
  const { service, admin } = await requirePlatformOperator(env, userId, true);
  const [programs, checklist, controls, gates, waitlist, referrals, events, experiments, actions, metrics] = await Promise.all([
    service.from('launch_programs').select('*').order('created_at', { ascending: false }).limit(30),
    service.from('launch_checklist_items').select('*').order('category').limit(300),
    service.from('public_access_controls').select('*').order('environment'),
    service.from('launch_gate_assessments').select('*').order('assessed_at', { ascending: false }).limit(50),
    service.from('waitlist_entries').select('id,status,source,medium,campaign,referral_code,consent_version,created_at,invited_at,converted_at').order('created_at', { ascending: false }).limit(300),
    service.from('referral_codes').select('*').order('created_at', { ascending: false }).limit(200),
    service.from('acquisition_events').select('event_type,source,medium,campaign,occurred_at').order('occurred_at', { ascending: false }).limit(500),
    service.from('growth_experiments').select('*').order('created_at', { ascending: false }).limit(100),
    service.from('lifecycle_actions').select('*').order('created_at', { ascending: false }).limit(200),
    service.from('daily_growth_metrics').select('*').order('metric_date', { ascending: false }).limit(180),
  ]);
  for (const result of [programs, checklist, controls, gates, waitlist, referrals, events, experiments, actions, metrics]) if (result.error) throw result.error;
  return { admin, programs: programs.data ?? [], checklist: checklist.data ?? [], controls: controls.data ?? [], gates: gates.data ?? [], waitlist: waitlist.data ?? [], referrals: referrals.data ?? [], events: events.data ?? [], experiments: experiments.data ?? [], lifecycle_actions: actions.data ?? [], metrics: metrics.data ?? [] };
}

export async function assessPublicLaunch(env: Env, userId: string, launchProgramId: string) {
  const { service } = await requirePlatformOperator(env, userId);
  const { data, error } = await service.rpc('record_public_launch_gate', { p_launch_program_id: launchProgramId, p_actor: userId });
  if (error) throw error;
  return data;
}

export async function openPublicLaunch(env: Env, userId: string, launchProgramId: string, confirmation: string, reason: string) {
  if (confirmation !== 'OPEN PUBLIC ACCESS') throw new Error('Type OPEN PUBLIC ACCESS to confirm.');
  const { service } = await requirePlatformOperator(env, userId);
  const { data, error } = await service.rpc('open_public_launch', { p_launch_program_id: launchProgramId, p_actor: userId, p_reason: reason });
  if (error) throw error;
  return data;
}

export async function pausePublicLaunch(env: Env, userId: string, confirmation: string, reason: string) {
  if (confirmation !== 'PAUSE PUBLIC ACCESS') throw new Error('Type PAUSE PUBLIC ACCESS to confirm.');
  const { service } = await requirePlatformOperator(env, userId);
  const { data, error } = await service.rpc('pause_public_launch', { p_actor: userId, p_reason: reason });
  if (error) throw error;
  return data;
}

export async function joinWaitlist(env: Env, input: { email: string; consentVersion: string; source?: string; medium?: string; campaign?: string; referralCode?: string; metadata?: unknown }) {
  const service = createServiceClient(env);
  const { data: control, error: controlError } = await service.from('public_access_controls').select('waitlist_open').eq('environment', 'production').single();
  if (controlError) throw controlError;
  if (!control.waitlist_open) throw new Error('The waitlist is currently closed.');
  const email = input.email.trim().toLowerCase();
  const emailHash = await sha256(email);
  const referralCode = (input.referralCode ?? '').trim().toUpperCase();
  if (referralCode && !validReferralCode(referralCode)) throw new Error('Referral code is invalid.');
  const { data, error } = await service.from('waitlist_entries').upsert({
    email_hash: emailHash,
    status: 'waiting',
    source: sanitizeAttribution(input.source) || 'direct',
    medium: sanitizeAttribution(input.medium),
    campaign: sanitizeAttribution(input.campaign),
    referral_code: referralCode,
    consent_version: input.consentVersion,
    consented_at: new Date().toISOString(),
    metadata: sanitizeGrowthProperties(input.metadata ?? {}),
  }, { onConflict: 'email_hash' }).select('id,status,created_at').single();
  if (error) throw error;
  if (referralCode) {
    const codeResult = await service.from('referral_codes').select('id,status,expires_at').eq('code', referralCode).maybeSingle();
    if (!codeResult.error && codeResult.data?.status === 'active' && (!codeResult.data.expires_at || new Date(codeResult.data.expires_at) > new Date())) {
      await service.from('referral_attributions').upsert({ referral_code_id: codeResult.data.id, waitlist_entry_id: data.id }, { onConflict: 'referral_code_id,waitlist_entry_id' });
    }
  }
  await recordAcquisitionEvent(service, { eventKey: `waitlist:${data.id}`, eventType: 'waitlist_joined', source: input.source, medium: input.medium, campaign: input.campaign, referralCode, properties: {} });
  return data;
}

export async function publicLaunchStatus(env: Env) {
  const service = createServiceClient(env);
  const { data, error } = await service.from('public_access_controls').select('registration_open,waitlist_open,invite_only,reason,opened_at').eq('environment', 'production').single();
  if (error) throw error;
  return data;
}

export async function recordAcquisitionEvent(service: ServiceClient, input: { eventKey: string; eventType: string; anonymousId?: string; userId?: string | null; workspaceId?: string | null; source?: string; medium?: string; campaign?: string; content?: string; referralCode?: string; properties?: unknown; occurredAt?: string }) {
  const anonymousIdHash = input.anonymousId ? await sha256(input.anonymousId) : '';
  const { data, error } = await service.from('acquisition_events').upsert({
    event_key: input.eventKey,
    event_type: input.eventType,
    anonymous_id_hash: anonymousIdHash,
    user_id: input.userId ?? null,
    workspace_id: input.workspaceId ?? null,
    source: sanitizeAttribution(input.source) || 'direct',
    medium: sanitizeAttribution(input.medium),
    campaign: sanitizeAttribution(input.campaign),
    content: sanitizeAttribution(input.content),
    referral_code: (input.referralCode ?? '').trim().toUpperCase(),
    properties: sanitizeGrowthProperties(input.properties ?? {}),
    occurred_at: input.occurredAt ?? new Date().toISOString(),
  }, { onConflict: 'event_key', ignoreDuplicates: true }).select('id').maybeSingle();
  if (error) throw error;
  return data;
}

export async function createReferralCode(env: Env, userId: string, workspaceId: string, maxConversions?: number | null) {
  const service = createServiceClient(env);
  const { data: member, error: memberError } = await service.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
  if (memberError) throw memberError;
  if (!member || !['owner','admin'].includes(member.role)) throw new Error('Workspace owner or administrator access is required.');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomCode();
    const result = await service.from('referral_codes').insert({ code, workspace_id: workspaceId, owner_user_id: userId, max_conversions: maxConversions ?? null }).select('*').single();
    if (!result.error) return result.data;
    if (!String(result.error.code).includes('23505')) throw result.error;
  }
  throw new Error('Could not allocate a referral code.');
}

export async function assignExperiment(env: Env, experimentKey: string, subjectId: string) {
  const service = createServiceClient(env);
  const { data: experiment, error } = await service.from('growth_experiments').select('*').eq('experiment_key', experimentKey).eq('status', 'running').maybeSingle();
  if (error) throw error;
  if (!experiment) return null;
  const subjectHash = await sha256(`${experimentKey}:${subjectId}`);
  const existing = await service.from('growth_experiment_assignments').select('*').eq('experiment_id', experiment.id).eq('subject_hash', subjectHash).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return { experiment_key: experimentKey, variant_key: existing.data.variant_key };
  const variant = assignGrowthVariant(subjectHash, experimentKey, experiment.variants as Array<{ key: string; weight?: number }>, experiment.allocation_percent);
  if (!variant) return null;
  const inserted = await service.from('growth_experiment_assignments').insert({ experiment_id: experiment.id, subject_hash: subjectHash, variant_key: variant }).select('*').single();
  if (inserted.error) throw inserted.error;
  return { experiment_key: experimentKey, variant_key: variant };
}

export async function growthHousekeeping(env: Env) {
  const service = createServiceClient(env);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await service.rpc('recompute_daily_growth_metrics', { p_date: yesterday });
  if (error) throw error;
  return { metric_date: yesterday, rows: data ?? 0 };
}
