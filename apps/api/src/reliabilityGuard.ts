import type { MiddlewareHandler } from 'hono';
import { createServiceClient } from './db';
import { classifyRequestRisk, controlReason } from './reliability';
import type { Env, Variables } from './types';

type AppEnv = { Bindings: Env; Variables: Variables };

export const reliabilityGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const environment = c.env.DEPLOYMENT_ENVIRONMENT ?? 'local';
  if (environment === 'local') return next();

  const path = new URL(c.req.url).pathname;
  const risk = classifyRequestRisk(c.req.method, path);
  if (risk === 'read' || risk === 'control_plane') return next();

  try {
    const service = createServiceClient(c.env);
    const { data, error } = await service.from('environment_controls').select('*').eq('environment', environment).maybeSingle();
    if (error) throw error;
    const reason = controlReason(data ?? {}, risk);
    if (reason) return c.json({
      error: reason,
      environment,
      operation_class: risk,
      retryable: true,
    }, 503, { 'Retry-After': '60' });
    return next();
  } catch (reason) {
    if (environment === 'production') {
      return c.json({
        error: 'The production safety control plane is unavailable. Mutating requests are paused until it recovers.',
        environment,
        operation_class: risk,
        detail: reason instanceof Error ? reason.message : String(reason),
        retryable: true,
      }, 503, { 'Retry-After': '60' });
    }
    return next();
  }
};
