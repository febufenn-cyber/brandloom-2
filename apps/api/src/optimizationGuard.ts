import type { MiddlewareHandler } from 'hono';
import { commercialMode } from './commercial';
import type { Env, Variables } from './types';

type AppEnv = { Bindings: Env; Variables: Variables };

export const optimizationExperimentGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (commercialMode(c.env) === 'mock') return next();
  const path = new URL(c.req.url).pathname;
  const experimentId = path.match(/^\/api\/v6\/experiments\/([^/]+)/)?.[1];
  if (!experimentId) return next();

  const supabase = c.get('supabase');
  const experimentResult = await supabase.from('brand_experiments').select('brand_id').eq('id', experimentId).maybeSingle();
  if (experimentResult.error) return c.json({ error: 'Experiment access could not be verified.' }, 503);
  if (!experimentResult.data) return c.json({ error: 'Experiment not found.' }, 404);

  const brandResult = await supabase.from('brands').select('workspace_id').eq('id', experimentResult.data.brand_id).single();
  if (brandResult.error) return c.json({ error: 'Experiment workspace could not be verified.' }, 503);
  const entitlementResult = await supabase.from('entitlement_snapshots').select('plan_code,features,access_state')
    .eq('workspace_id', brandResult.data.workspace_id).order('version', { ascending: false }).limit(1).maybeSingle();
  if (entitlementResult.error) return c.json({ error: 'Workspace entitlement could not be verified.' }, 503);

  const entitlement = entitlementResult.data as { plan_code?: string; features?: Record<string, unknown>; access_state?: string } | null;
  const enabled = entitlement?.features?.controlled_experiments === true || ['growth', 'agency'].includes(entitlement?.plan_code ?? '');
  if (!enabled || !['full', 'grace'].includes(entitlement?.access_state ?? '')) {
    return c.json({ error: 'Controlled experiments require an active Growth or Agency entitlement.' }, 402);
  }
  return next();
};
