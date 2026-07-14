import { createServiceClient } from './db';
import { inviteExpiresAt, sanitizeBetaContext } from './beta';
import { requirePlatformOperator } from './reliabilityService';
import type { Env } from './types';

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function betaDashboard(env: Env, userId: string) {
  const { service, admin } = await requirePlatformOperator(env, userId, true);
  const [programs, participants, invites, feedback, qaRuns, findings, assessments] = await Promise.all([
    service.from('beta_programs').select('*').order('created_at', { ascending: false }).limit(30),
    service.from('beta_participants').select('*').order('created_at', { ascending: false }).limit(300),
    service.from('beta_invites').select('id,program_id,status,intended_role,expires_at,accepted_at,created_at').order('created_at', { ascending: false }).limit(200),
    service.from('beta_feedback').select('*').order('created_at', { ascending: false }).limit(250),
    service.from('qa_test_runs').select('*').order('started_at', { ascending: false }).limit(250),
    service.from('security_findings').select('*').order('created_at', { ascending: false }).limit(200),
    service.from('beta_gate_assessments').select('*').order('assessed_at', { ascending: false }).limit(50),
  ]);
  for (const result of [programs, participants, invites, feedback, qaRuns, findings, assessments]) if (result.error) throw result.error;
  return {
    admin,
    programs: programs.data ?? [],
    participants: participants.data ?? [],
    invites: invites.data ?? [],
    feedback: feedback.data ?? [],
    qa_runs: qaRuns.data ?? [],
    findings: findings.data ?? [],
    assessments: assessments.data ?? [],
  };
}

export async function createBetaInvite(env: Env, userId: string, input: {
  programId: string;
  email: string;
  intendedRole: string;
  expiresInHours?: number;
}) {
  const { service } = await requirePlatformOperator(env, userId);
  const email = input.email.trim().toLowerCase();
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = base64Url(tokenBytes);
  const [tokenHash, emailHash] = await Promise.all([sha256(token), sha256(email)]);
  const { data, error } = await service.from('beta_invites').insert({
    program_id: input.programId,
    email_hash: emailHash,
    token_hash: tokenHash,
    intended_role: input.intendedRole,
    expires_at: inviteExpiresAt(input.expiresInHours ?? 72),
    invited_by: userId,
  }).select('id,program_id,status,intended_role,expires_at,created_at').single();
  if (error) throw error;
  const origin = (env.BETA_APP_ORIGIN ?? env.WEB_ORIGIN ?? '').replace(/\/$/, '');
  return {
    invite: data,
    invite_url: `${origin}/#beta-invite?token=${encodeURIComponent(token)}`,
    token,
    delivery: 'manual',
  };
}

export async function acceptBetaInvite(env: Env, userId: string, token: string, consentVersion: string) {
  const service = createServiceClient(env);
  const tokenHash = await sha256(token);
  const { data, error } = await service.rpc('accept_beta_invite', {
    p_token_hash: tokenHash,
    p_user_id: userId,
    p_consent_version: consentVersion,
  });
  if (error) throw error;
  return { participant_id: data };
}

export async function submitBetaFeedback(env: Env, userId: string, input: {
  programId: string;
  workspaceId?: string | null;
  category: string;
  severity: string;
  title: string;
  description?: string;
  reproduction?: string;
  traceId?: string;
  context?: unknown;
}) {
  const service = createServiceClient(env);
  const { data: participant, error: participantError } = await service.from('beta_participants')
    .select('id,status').eq('program_id', input.programId).eq('user_id', userId).maybeSingle();
  if (participantError) throw participantError;
  if (!participant || !['accepted', 'onboarding', 'active'].includes(participant.status)) throw new Error('Active beta participation is required.');
  const { data, error } = await service.from('beta_feedback').insert({
    program_id: input.programId,
    participant_id: participant.id,
    workspace_id: input.workspaceId ?? null,
    submitted_by: userId,
    category: input.category,
    severity: input.severity,
    title: input.title,
    description: input.description ?? '',
    reproduction: input.reproduction ?? '',
    trace_id: (input.traceId ?? '').slice(0, 160),
    safe_context: sanitizeBetaContext(input.context ?? {}),
  }).select('*').single();
  if (error) throw error;
  return data;
}

export async function assessBetaGate(env: Env, userId: string, environment: 'staging' | 'production', programId: string) {
  const { service } = await requirePlatformOperator(env, userId);
  const { data, error } = await service.rpc('record_beta_gate_assessment', {
    p_environment: environment,
    p_program_id: programId,
    p_actor: userId,
  });
  if (error) throw error;
  return data;
}

export async function betaHousekeeping(env: Env) {
  const service = createServiceClient(env);
  const now = new Date().toISOString();
  const [invites, limits] = await Promise.all([
    service.from('beta_invites').update({ status: 'expired' }).eq('status', 'pending').lte('expires_at', now),
    service.rpc('cleanup_rate_limit_buckets'),
  ]);
  if (invites.error) throw invites.error;
  if (limits.error) throw limits.error;
  return { expired_invites: true, deleted_rate_limit_buckets: limits.data ?? 0 };
}
