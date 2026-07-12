import { createClient } from '@supabase/supabase-js';
import type { Env } from './types';

export function createUserClient(env: Env, token: string) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createServiceClient(env: Env) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured.');
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function loadBrandBundle(supabase: ReturnType<typeof createUserClient>, brandId: string) {
  const [brandResult, profileResult, productsResult, audiencesResult] = await Promise.all([
    supabase.from('brands').select('*').eq('id', brandId).single(),
    supabase.from('brand_voice_profiles').select('*').eq('brand_id', brandId).maybeSingle(),
    supabase.from('products').select('*').eq('brand_id', brandId).eq('active', true).order('created_at'),
    supabase.from('audiences').select('*').eq('brand_id', brandId).order('is_primary', { ascending: false }),
  ]);
  if (brandResult.error) throw brandResult.error;
  if (profileResult.error) throw profileResult.error;
  if (productsResult.error) throw productsResult.error;
  if (audiencesResult.error) throw audiencesResult.error;
  return {
    brand: brandResult.data,
    profile: profileResult.data,
    products: productsResult.data ?? [],
    audiences: audiencesResult.data ?? [],
  };
}
