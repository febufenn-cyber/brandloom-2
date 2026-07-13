import { createServiceClient } from './db';
import { billingAccessState, commercialMode, periodKey, sha256 } from './commercial';
import { billingProvider } from './billingProvider';
import type { Env } from './types';

type Row = Record<string, any>;

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function createCheckout(env: Env, input: {
  workspaceId: string;
  planCode: string;
  userId: string;
  email?: string | null;
}) {
  const service = createServiceClient(env);
  const { data: plan, error: planError } = await service.from('billing_plans').select('*').eq('code', input.planCode).eq('public', true).eq('active', true).single();
  if (planError || !plan) throw new Error('Selected plan is unavailable.');

  if (commercialMode(env) === 'mock') {
    const token = randomToken();
    const { data, error } = await service.from('mock_checkout_sessions').insert({
      workspace_id: input.workspaceId,
      plan_code: input.planCode,
      token_hash: await sha256(token),
      requested_by: input.userId,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    }).select('id').single();
    if (error) throw error;
    const origin = env.WEB_ORIGIN ?? 'http://localhost:5173';
    return { provider: 'mock', sessionId: data.id, url: `${origin}/#commercial?mock_checkout=${token}` };
  }

  const { data: price, error: priceError } = await service.from('billing_prices').select('*')
    .eq('plan_code', input.planCode).eq('provider', 'stripe').eq('active', true).eq('billing_interval', 'month').maybeSingle();
  if (priceError || !price) throw new Error('Stripe price is not configured for this plan.');
  const { data: customer } = await service.from('billing_customers').select('*').eq('workspace_id', input.workspaceId).maybeSingle();
  const origin = env.WEB_ORIGIN ?? 'http://localhost:5173';
  const result = await billingProvider(env).createCheckout({
    workspaceId: input.workspaceId,
    planCode: input.planCode,
    priceId: price.provider_price_id,
    customerId: customer?.provider === 'stripe' ? customer.provider_customer_id : null,
    customerEmail: input.email,
    successUrl: env.STRIPE_SUCCESS_URL ?? `${origin}/#commercial?checkout=success`,
    cancelUrl: env.STRIPE_CANCEL_URL ?? `${origin}/#commercial?checkout=cancelled`,
  });
  return { provider: 'stripe', sessionId: result.id, url: result.url };
}

export async function completeMockCheckout(env: Env, workspaceId: string, userId: string, token: string) {
  const service = createServiceClient(env);
  const hash = await sha256(token);
  const { data: session, error } = await service.from('mock_checkout_sessions').select('*')
    .eq('token_hash', hash).eq('workspace_id', workspaceId).eq('requested_by', userId).eq('status', 'pending').gt('expires_at', new Date().toISOString()).single();
  if (error || !session) throw new Error('Mock checkout session is invalid or expired.');

  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
  const customerId = `mock_customer_${workspaceId}`;
  const subscriptionId = `mock_subscription_${workspaceId}`;

  const { error: customerError } = await service.from('billing_customers').upsert({
    workspace_id: workspaceId,
    provider: 'mock',
    provider_customer_id: customerId,
    provider_snapshot: { source: 'mock_checkout' },
  }, { onConflict: 'workspace_id' });
  if (customerError) throw customerError;

  const { error: subscriptionError } = await service.from('subscriptions').upsert({
    workspace_id: workspaceId,
    provider: 'mock',
    provider_subscription_id: subscriptionId,
    plan_code: session.plan_code,
    status: 'active',
    access_state: 'full',
    trial_start: null,
    trial_end: null,
    current_period_start: now.toISOString(),
    current_period_end: periodEnd.toISOString(),
    cancel_at_period_end: false,
    canceled_at: null,
    grace_ends_at: null,
    provider_snapshot: { mock_checkout_session_id: session.id },
  }, { onConflict: 'workspace_id' });
  if (subscriptionError) throw subscriptionError;

  await service.from('mock_checkout_sessions').update({ status: 'completed', completed_at: now.toISOString() }).eq('id', session.id);
  await service.rpc('recalculate_workspace_entitlements', { p_workspace_id: workspaceId });
  return { workspace_id: workspaceId, plan_code: session.plan_code, status: 'active' };
}

export async function createPortal(env: Env, workspaceId: string) {
  if (commercialMode(env) === 'mock') return { url: `${env.WEB_ORIGIN ?? 'http://localhost:5173'}/#commercial?portal=mock` };
  const service = createServiceClient(env);
  const { data: customer, error } = await service.from('billing_customers').select('*').eq('workspace_id', workspaceId).single();
  if (error || !customer || customer.provider !== 'stripe') throw new Error('Stripe customer is not available.');
  return billingProvider(env).createPortal(customer.provider_customer_id, `${env.WEB_ORIGIN ?? 'http://localhost:5173'}/#commercial`);
}

function subscriptionStatus(value: unknown) {
  const allowed = ['trialing', 'active', 'incomplete', 'incomplete_expired', 'past_due', 'unpaid', 'paused', 'canceled'];
  return allowed.includes(String(value)) ? String(value) : 'incomplete';
}

async function workspaceFromCustomer(service: ReturnType<typeof createServiceClient>, customerId: string | null | undefined) {
  if (!customerId) return null;
  const { data } = await service.from('billing_customers').select('workspace_id').eq('provider_customer_id', customerId).maybeSingle();
  return data?.workspace_id as string | null | undefined;
}

async function planFromPrice(service: ReturnType<typeof createServiceClient>, priceId: string | null | undefined) {
  if (!priceId) return null;
  const { data } = await service.from('billing_prices').select('plan_code').eq('provider', 'stripe').eq('provider_price_id', priceId).maybeSingle();
  return data?.plan_code as string | null | undefined;
}

export async function processStripeEvent(env: Env, eventId: string) {
  const service = createServiceClient(env);
  const { data: stored, error } = await service.from('billing_events').select('*').eq('provider_event_id', eventId).single();
  if (error) throw error;
  if (stored.status === 'processed' || stored.status === 'ignored') return { duplicate: true };
  await service.from('billing_events').update({ status: 'processing', attempts: stored.attempts + 1 }).eq('id', stored.id);

  try {
    const event = stored.payload as Row;
    const object = event.data?.object as Row | undefined;
    const type = String(event.type ?? stored.event_type);
    if (!object) throw new Error('Stripe event object is missing.');

    if (type === 'checkout.session.completed') {
      const workspaceId = String(object.metadata?.workspace_id ?? object.client_reference_id ?? '');
      if (!workspaceId) throw new Error('Checkout session lacks workspace metadata.');
      const customerId = String(object.customer ?? '');
      if (customerId) {
        await service.from('billing_customers').upsert({
          workspace_id: workspaceId,
          provider: 'stripe',
          provider_customer_id: customerId,
          billing_email: String(object.customer_details?.email ?? object.customer_email ?? ''),
          provider_snapshot: object,
        }, { onConflict: 'workspace_id' });
      }
      await service.from('billing_events').update({ status: 'processed', processed_at: new Date().toISOString() }).eq('id', stored.id);
      return { processed: true, type };
    }

    if (type.startsWith('customer.subscription.')) {
      const customerId = String(object.customer ?? '');
      const workspaceId = String(object.metadata?.workspace_id ?? await workspaceFromCustomer(service, customerId) ?? '');
      if (!workspaceId) throw new Error('Subscription could not be mapped to a workspace.');
      const priceId = object.items?.data?.[0]?.price?.id as string | undefined;
      const planCode = String(object.metadata?.plan_code ?? await planFromPrice(service, priceId) ?? 'trial');
      const status = subscriptionStatus(object.status);
      const grace = status === 'past_due' ? new Date(Date.now() + 7 * 86_400_000).toISOString() : null;
      const seconds = (value: unknown) => typeof value === 'number' ? new Date(value * 1000).toISOString() : null;
      await service.from('subscriptions').upsert({
        workspace_id: workspaceId,
        provider: 'stripe',
        provider_subscription_id: String(object.id),
        plan_code: planCode,
        status,
        access_state: billingAccessState(status as Parameters<typeof billingAccessState>[0], grace),
        trial_start: seconds(object.trial_start),
        trial_end: seconds(object.trial_end),
        current_period_start: seconds(object.current_period_start),
        current_period_end: seconds(object.current_period_end),
        cancel_at_period_end: Boolean(object.cancel_at_period_end),
        canceled_at: seconds(object.canceled_at),
        grace_ends_at: grace,
        provider_snapshot: object,
      }, { onConflict: 'workspace_id' });
      await service.from('billing_events').update({ status: 'processed', processed_at: new Date().toISOString() }).eq('id', stored.id);
      return { processed: true, type };
    }

    if (type === 'invoice.payment_failed' || type === 'invoice.paid') {
      const providerSubscriptionId = typeof object.subscription === 'string' ? object.subscription : object.subscription?.id;
      if (providerSubscriptionId) {
        const update = type === 'invoice.paid'
          ? { status: 'active', access_state: 'full', grace_ends_at: null }
          : { status: 'past_due', access_state: 'grace', grace_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString() };
        await service.from('subscriptions').update(update).eq('provider_subscription_id', providerSubscriptionId);
      }
      await service.from('billing_events').update({ status: 'processed', processed_at: new Date().toISOString() }).eq('id', stored.id);
      return { processed: true, type };
    }

    await service.from('billing_events').update({ status: 'ignored', processed_at: new Date().toISOString() }).eq('id', stored.id);
    return { ignored: true, type };
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    await service.from('billing_events').update({ status: 'failed', error_message: message }).eq('id', stored.id);
    throw reason;
  }
}

export async function commercialDashboard(supabase: any, workspaceId: string) {
  const period = periodKey();
  const [subscription, entitlement, usage, reservations, credits, controls, exports, deletions] = await Promise.all([
    supabase.from('subscriptions').select('*').eq('workspace_id', workspaceId).maybeSingle(),
    supabase.from('entitlement_snapshots').select('*').eq('workspace_id', workspaceId).order('version', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('usage_ledger').select('*').eq('workspace_id', workspaceId).eq('period_key', period).order('created_at', { ascending: false }),
    supabase.from('usage_reservations').select('*').eq('workspace_id', workspaceId).eq('period_key', period).eq('status', 'reserved'),
    supabase.from('workspace_credits').select('*').eq('workspace_id', workspaceId),
    supabase.from('workspace_commercial_controls').select('*').eq('workspace_id', workspaceId).maybeSingle(),
    supabase.from('data_export_jobs').select('id,status,created_at,completed_at,expires_at,checksum').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(10),
    supabase.from('deletion_requests').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(10),
  ]);
  for (const result of [subscription, entitlement, usage, reservations, credits, controls, exports, deletions]) if (result.error) throw result.error;
  const rows = usage.data ?? [];
  const usageByType = rows.reduce((acc: Record<string, number>, row: Row) => {
    acc[row.usage_type] = (acc[row.usage_type] ?? 0) + Number(row.quantity);
    return acc;
  }, {});
  const creditTotal = (credits.data ?? []).filter((row: Row) => !row.expires_at || new Date(row.expires_at) > new Date()).reduce((sum: number, row: Row) => sum + Number(row.quantity), 0);
  const reserved = (reservations.data ?? []).reduce((sum: number, row: Row) => sum + Number(row.reserved_quantity), 0);
  return {
    period,
    subscription: subscription.data,
    entitlement: entitlement.data,
    usage: rows,
    usage_by_type: usageByType,
    active_reservations: reserved,
    credits: creditTotal,
    controls: controls.data,
    exports: exports.data ?? [],
    deletions: deletions.data ?? [],
  };
}

export async function createWorkspaceExport(supabase: any, workspaceId: string, userId: string) {
  const { data: job, error: jobError } = await supabase.from('data_export_jobs').insert({
    workspace_id: workspaceId,
    requested_by: userId,
    status: 'running',
  }).select('*').single();
  if (jobError) throw jobError;
  try {
    const { data: brands, error: brandError } = await supabase.from('brands').select('*').eq('workspace_id', workspaceId);
    if (brandError) throw brandError;
    const brandIds = (brands ?? []).map((brand: Row) => brand.id);
    const safe = async (table: string, column: string, ids: string[]) => {
      if (!ids.length) return [];
      const result = await supabase.from(table).select('*').in(column, ids);
      if (result.error) throw result.error;
      return result.data ?? [];
    };
    const [profiles, products, audiences, campaigns, content, memories, usage, publications, subscription] = await Promise.all([
      safe('brand_voice_profiles', 'brand_id', brandIds),
      safe('products', 'brand_id', brandIds),
      safe('audiences', 'brand_id', brandIds),
      safe('campaigns', 'brand_id', brandIds),
      safe('content_items', 'brand_id', brandIds),
      safe('memory_items', 'brand_id', brandIds),
      supabase.from('usage_ledger').select('*').eq('workspace_id', workspaceId).then((result: any) => { if (result.error) throw result.error; return result.data ?? []; }),
      supabase.from('publication_jobs').select('*, publication_snapshots(*)').eq('workspace_id', workspaceId).then((result: any) => { if (result.error) throw result.error; return result.data ?? []; }),
      supabase.from('subscriptions').select('*').eq('workspace_id', workspaceId).maybeSingle().then((result: any) => { if (result.error) throw result.error; return result.data; }),
    ]);
    const payload = { exported_at: new Date().toISOString(), workspace_id: workspaceId, brands, profiles, products, audiences, campaigns, content, memories, usage, publications, subscription };
    const digest = await sha256(JSON.stringify(payload));
    const expiresAt = new Date(Date.now() + 72 * 60 * 60_000).toISOString();
    const { data, error } = await supabase.from('data_export_jobs').update({ status: 'completed', payload, checksum: digest, completed_at: new Date().toISOString(), expires_at: expiresAt }).eq('id', job.id).select('*').single();
    if (error) throw error;
    return data;
  } catch (reason) {
    await supabase.from('data_export_jobs').update({ status: 'failed', error_message: reason instanceof Error ? reason.message : String(reason) }).eq('id', job.id);
    throw reason;
  }
}

export async function commercialHousekeeping(env: Env) {
  const service = createServiceClient(env);
  const { data, error } = await service.rpc('expire_commercial_state');
  if (error) throw error;
  return data;
}
