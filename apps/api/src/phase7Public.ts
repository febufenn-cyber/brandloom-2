import { Hono } from 'hono';
import { publicReadiness } from './reliabilityService';
import type { Env, Variables } from './types';

const phase7Public = new Hono<{ Bindings: Env; Variables: Variables }>();

phase7Public.get('/health/live', (c) => c.json({
  ok: true,
  service: 'brandloom-api',
  environment: c.env.DEPLOYMENT_ENVIRONMENT ?? 'local',
  version: c.env.APP_VERSION ?? 'unconfigured',
  commit_sha: c.env.COMMIT_SHA ?? 'unconfigured',
  timestamp: new Date().toISOString(),
}));

phase7Public.get('/health/ready', async (c) => {
  const readiness = await publicReadiness(c.env);
  return c.json(readiness, readiness.ok ? 200 : 503);
});

export default phase7Public;
