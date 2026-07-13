import type { MiddlewareHandler } from 'hono';
import { createUserClient } from './db';
import { generationChargeForRequest } from './commercial';
import type { Env, Variables } from './types';

type AppEnv = { Bindings: Env; Variables: Variables };

async function resolveBrandId(supabase: Variables['supabase'], path: string) {
  const direct = path.match(/^\/api\/(?:v\d+\/)?brands\/([^/]+)/)?.[1];
  if (direct) return direct;

  const planId = path.match(/^\/api\/(?:v2\/)?weekly-plans\/([^/]+)/)?.[1];
  if (planId) {
    const { data } = await supabase.from('weekly_plans').select('brand_id').eq('id', planId).maybeSingle();
    return data?.brand_id as string | undefined;
  }

  const contentId = path.match(/^\/api\/(?:v2\/|v3\/)?content-items\/([^/]+)/)?.[1];
  if (contentId) {
    const { data } = await supabase.from('content_items').select('brand_id').eq('id', contentId).maybeSingle();
    return data?.brand_id as string | undefined;
  }

  const campaignId = path.match(/^\/api\/v3\/campaigns\/([^/]+)/)?.[1];
  if (campaignId) {
    const { data } = await supabase.from('campaigns').select('brand_id').eq('id', campaignId).maybeSingle();
    return data?.brand_id as string | undefined;
  }
  return undefined;
}

export const commercialGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const charge = generationChargeForRequest(c.req.method, path);
  if (!charge) return next();

  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) return next();
  const token = header.slice(7);
  const supabase = createUserClient(c.env, token);
  const { data: userResult, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userResult.user) return next();

  const brandId = await resolveBrandId(supabase, path);
  if (!brandId) return next();
  const { data: brand, error: brandError } = await supabase.from('brands').select('workspace_id').eq('id', brandId).single();
  if (brandError) return next();

  const requestId = c.req.header('Idempotency-Key') ?? crypto.randomUUID();
  const { data: reservationRows, error: reserveError } = await supabase.rpc('reserve_workspace_usage', {
    p_workspace_id: brand.workspace_id,
    p_user_id: userResult.user.id,
    p_brand_id: brandId,
    p_usage_type: charge.usageType,
    p_quantity: charge.units,
    p_request_id: requestId,
    p_ttl_seconds: 1800,
  });
  if (reserveError) return c.json({ error: 'Usage allowance could not be verified.', detail: reserveError.message }, 503);
  const reservation = Array.isArray(reservationRows) ? reservationRows[0] : reservationRows;
  if (!reservation?.allowed || !reservation?.reservation_id) {
    return c.json({ error: reservation?.reason ?? 'Generation is unavailable for this workspace.', remaining: reservation?.remaining ?? 0 }, 402);
  }

  await next();
  if (c.res.status < 400) {
    await supabase.rpc('finalize_workspace_usage', {
      p_reservation_id: reservation.reservation_id,
      p_actual_quantity: charge.units,
      p_provider: 'anthropic',
      p_model: c.env.ANTHROPIC_MODEL ?? '',
      p_input_tokens: 0,
      p_output_tokens: 0,
      p_estimated_cost_micros: 0,
      p_metadata: { label: charge.label, request_path: path },
    });
  } else {
    await supabase.rpc('release_workspace_usage', { p_reservation_id: reservation.reservation_id });
  }
};
