import type { MiddlewareHandler } from 'hono';
import { createServiceClient } from './db';
import { rateLimitPolicy } from './beta';
import type { Env, Variables } from './types';

async function hashKey(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const securityHeaders: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const requestId = c.req.header('X-Request-ID')?.slice(0, 120) || crypto.randomUUID();
  c.header('X-Request-ID', requestId);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  c.header('Cross-Origin-Resource-Policy', 'same-site');
  if ((c.env.DEPLOYMENT_ENVIRONMENT ?? 'local') === 'production') c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  await next();
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/webhooks/')) c.header('Cache-Control', 'no-store');
};

export const apiRateLimitGuard: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const policy = rateLimitPolicy(c.req.method, c.req.path);
  if (!policy) return next();
  const environment = c.env.DEPLOYMENT_ENVIRONMENT ?? 'local';
  if (environment === 'local' && !c.env.RATE_LIMIT_SALT) return next();
  if (!c.env.RATE_LIMIT_SALT) return c.json({ error: 'Request safety configuration is unavailable.' }, 503);

  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';
  const authorization = c.req.header('Authorization') ?? 'anonymous';
  const identity = await hashKey(`${c.env.RATE_LIMIT_SALT}:${ip}:${authorization.slice(0, 64)}`);
  try {
    const service = createServiceClient(c.env);
    const { data, error } = await service.rpc('consume_api_rate_limit', {
      p_key_hash: identity,
      p_scope: policy.scope,
      p_limit: policy.limit,
      p_window_seconds: policy.windowSeconds,
    });
    if (error) throw error;
    const result = data as { allowed?: boolean; remaining?: number; limit?: number; reset_at?: string } | null;
    c.header('X-RateLimit-Limit', String(result?.limit ?? policy.limit));
    c.header('X-RateLimit-Remaining', String(result?.remaining ?? 0));
    if (result?.reset_at) c.header('X-RateLimit-Reset', result.reset_at);
    if (!result?.allowed) return c.json({ error: 'Too many requests. Try again after the rate-limit window resets.' }, 429);
    await next();
  } catch (reason) {
    if (environment === 'production') return c.json({ error: 'Request safety controls are temporarily unavailable.' }, 503);
    await next();
  }
};
