import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptSecret, encryptSecret, randomToken, sha256Base64Url, sha256Hex } from './crypto';
import { createServiceClient } from './db';
import { publishingProvider } from './providers';
import type { OAuthToken } from './providers/types';
import type { Env } from './types';

export async function createOAuthAttempt(input: {
  env: Env;
  supabase: SupabaseClient;
  brandId: string;
  userId: string;
}) {
  const { data: brand, error } = await input.supabase.from('brands').select('workspace_id').eq('id', input.brandId).single();
  if (error) throw error;
  const state = randomToken(32);
  const verifier = randomToken(48);
  const challenge = await sha256Base64Url(verifier);
  const encrypted = await encryptSecret(verifier, input.env.TOKEN_ENCRYPTION_KEY);
  const scopes = (input.env.META_REQUIRED_SCOPES ?? 'instagram_business_basic,instagram_business_content_publish')
    .split(',').map((scope) => scope.trim()).filter(Boolean);
  const { error: insertError } = await input.supabase.from('oauth_connection_attempts').insert({
    workspace_id: brand.workspace_id,
    brand_id: input.brandId,
    provider: 'meta_instagram',
    state_hash: await sha256Hex(state),
    code_verifier_ciphertext: encrypted.ciphertext,
    code_verifier_nonce: encrypted.nonce,
    redirect_uri: input.env.META_REDIRECT_URI ?? '',
    requested_scopes: scopes,
    created_by: input.userId,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (insertError) throw insertError;
  return {
    authorizationUrl: publishingProvider(input.env).buildAuthorizationUrl({ state, codeChallenge: challenge }),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

async function saveCredential(env: Env, connectionId: string, token: OAuthToken) {
  const service = createServiceClient(env);
  const access = await encryptSecret(token.accessToken, env.TOKEN_ENCRYPTION_KEY);
  const refresh = token.refreshToken ? await encryptSecret(token.refreshToken, env.TOKEN_ENCRYPTION_KEY) : null;
  const expiresAt = token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null;
  const { error } = await service.from('platform_credentials').upsert({
    connection_id: connectionId,
    access_token_ciphertext: access.ciphertext,
    access_token_nonce: access.nonce,
    refresh_token_ciphertext: refresh?.ciphertext ?? null,
    refresh_token_nonce: refresh?.nonce ?? null,
    token_type: token.tokenType ?? 'Bearer',
    expires_at: expiresAt,
    last_refreshed_at: new Date().toISOString(),
  }, { onConflict: 'connection_id' });
  if (error) throw error;
  return expiresAt;
}

export async function loadAccessToken(env: Env, connectionId: string) {
  const service = createServiceClient(env);
  const { data, error } = await service.from('platform_credentials').select('*').eq('connection_id', connectionId).single();
  if (error) throw error;
  if (data.revoked_at) throw new Error('The platform credential has been revoked.');
  return {
    accessToken: await decryptSecret(data.access_token_ciphertext, data.access_token_nonce, env.TOKEN_ENCRYPTION_KEY),
    expiresAt: data.expires_at as string | null,
  };
}

export async function completeOAuthCallback(env: Env, code: string, state: string) {
  const service = createServiceClient(env);
  const stateHash = await sha256Hex(state);
  const { data: attempt, error } = await service.from('oauth_connection_attempts').select('*')
    .eq('state_hash', stateHash).eq('status', 'pending').gt('expires_at', new Date().toISOString()).maybeSingle();
  if (error) throw error;
  if (!attempt) throw new Error('The connection attempt is invalid, expired or already used.');

  try {
    const verifier = attempt.code_verifier_ciphertext && attempt.code_verifier_nonce
      ? await decryptSecret(attempt.code_verifier_ciphertext, attempt.code_verifier_nonce, env.TOKEN_ENCRYPTION_KEY)
      : undefined;
    const provider = publishingProvider(env);
    const shortToken = await provider.exchangeCode(code, verifier);
    const token = await provider.extendToken(shortToken);
    const identity = await provider.inspectIdentity(token.accessToken);
    const { data: connection, error: connectionError } = await service.from('platform_connections').insert({
      workspace_id: attempt.workspace_id,
      provider: 'meta_instagram',
      connected_by: attempt.created_by,
      provider_user_id: token.providerUserId ?? identity.providerUserId,
      granted_scopes: token.scopes ?? attempt.requested_scopes,
      status: 'connected',
      last_validated_at: new Date().toISOString(),
      metadata: { provider_mode: env.PUBLISHING_PROVIDER_MODE ?? 'mock' },
    }).select('*').single();
    if (connectionError) throw connectionError;
    const expiresAt = await saveCredential(env, connection.id, token);
    const { data: account, error: accountError } = await service.from('platform_accounts').insert({
      connection_id: connection.id,
      provider_account_id: identity.providerAccountId,
      username: identity.username,
      display_name: identity.displayName,
      profile_image_url: identity.profileImageUrl,
      account_type: identity.accountType,
      capabilities: identity.capabilities,
      status: 'discovered',
      last_synced_at: new Date().toISOString(),
    }).select('*').single();
    if (accountError) throw accountError;
    const { error: mappingError } = await service.from('brand_platform_accounts').insert({
      brand_id: attempt.brand_id,
      platform_account_id: account.id,
      is_default: true,
      publishing_enabled: false,
    });
    if (mappingError) throw mappingError;
    await service.from('oauth_connection_attempts').update({ status: 'consumed', consumed_at: new Date().toISOString() }).eq('id', attempt.id);
    return { brandId: attempt.brand_id as string, connection, account, expiresAt };
  } catch (callbackError) {
    await service.from('oauth_connection_attempts').update({
      status: 'failed', safe_error: callbackError instanceof Error ? callbackError.message.slice(0, 1000) : 'Connection failed.',
    }).eq('id', attempt.id);
    throw callbackError;
  }
}

export async function revalidateConnection(env: Env, connectionId: string) {
  const service = createServiceClient(env);
  const credential = await loadAccessToken(env, connectionId);
  const provider = publishingProvider(env);
  try {
    let accessToken = credential.accessToken;
    if (credential.expiresAt && new Date(credential.expiresAt).getTime() < Date.now() + 7 * 24 * 60 * 60_000) {
      const refreshed = await provider.refreshToken(accessToken);
      accessToken = refreshed.accessToken;
      await saveCredential(env, connectionId, refreshed);
    }
    const result = await provider.validateConnection(accessToken);
    const { data: account } = await service.from('platform_accounts').select('id').eq('connection_id', connectionId).eq('provider_account_id', result.identity.providerAccountId).maybeSingle();
    if (account) await service.from('platform_accounts').update({
      username: result.identity.username,
      display_name: result.identity.displayName,
      profile_image_url: result.identity.profileImageUrl,
      account_type: result.identity.accountType,
      capabilities: result.identity.capabilities,
      status: 'healthy',
      last_synced_at: new Date().toISOString(),
    }).eq('id', account.id);
    await service.from('platform_connections').update({ status: 'healthy', granted_scopes: result.scopes, last_validated_at: new Date().toISOString(), reauthorization_required_at: null }).eq('id', connectionId);
    await service.from('connection_health_checks').insert({ connection_id: connectionId, status: 'healthy', scopes: result.scopes, capabilities: result.identity.capabilities, safe_errors: [] });
    return result;
  } catch (validationError) {
    const message = validationError instanceof Error ? validationError.message : 'Connection validation failed.';
    await service.from('platform_connections').update({ status: 'reauthorization_required', reauthorization_required_at: new Date().toISOString() }).eq('id', connectionId);
    await service.from('connection_health_checks').insert({ connection_id: connectionId, status: 'reauthorization_required', scopes: [], capabilities: {}, safe_errors: [{ message }] });
    throw validationError;
  }
}

export async function disconnectConnection(env: Env, connectionId: string) {
  const service = createServiceClient(env);
  try {
    const credential = await loadAccessToken(env, connectionId);
    await publishingProvider(env).disconnect(credential.accessToken);
  } catch {
    // Local revocation must still complete when the provider token is already invalid.
  }
  const now = new Date().toISOString();
  await service.from('platform_credentials').delete().eq('connection_id', connectionId);
  await service.from('platform_connections').update({ status: 'disconnected', disconnected_at: now }).eq('id', connectionId);
  const { data: accounts } = await service.from('platform_accounts').select('id').eq('connection_id', connectionId);
  if (accounts?.length) {
    const accountIds = accounts.map((account: { id: string }) => account.id);
    await service.from('platform_accounts').update({ status: 'disconnected' }).in('id', accountIds);
    const { data: snapshots } = await service.from('publication_snapshots').select('id').in('platform_account_id', accountIds);
    if (snapshots?.length) await service.from('publication_jobs').update({ status: 'manual_action_required', safe_error_message: 'The destination account was disconnected.' })
      .in('publication_snapshot_id', snapshots.map((snapshot: { id: string }) => snapshot.id))
      .in('status', ['scheduled', 'ready', 'retry_waiting']);
  }
}
