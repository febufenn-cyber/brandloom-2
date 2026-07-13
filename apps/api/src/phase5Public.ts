import { Hono } from 'hono';
import { PLAN_CATALOG, sha256, verifyStripeWebhook } from './commercial';
import { createServiceClient } from './db';
import { processStripeEvent } from './commercialService';
import type { Env } from './types';

const phase5Public = new Hono<{ Bindings: Env }>();

phase5Public.get('/billing/plans', (c) => c.json({ plans: PLAN_CATALOG }));

phase5Public.post('/webhooks/billing', async (c) => {
  if ((c.env.BILLING_PROVIDER_MODE ?? 'mock') !== 'stripe') return c.json({ received: true, ignored: 'stripe billing is disabled' });
  const body = await c.req.text();
  const signature = c.req.header('Stripe-Signature') ?? '';
  if (!c.env.STRIPE_WEBHOOK_SECRET || !(await verifyStripeWebhook(body, signature, c.env.STRIPE_WEBHOOK_SECRET))) {
    return c.json({ error: 'Invalid billing webhook signature.' }, 400);
  }
  const event = JSON.parse(body) as Record<string, any>;
  if (typeof event.id !== 'string' || typeof event.type !== 'string') return c.json({ error: 'Invalid Stripe event.' }, 400);
  const service = createServiceClient(c.env);
  const { error } = await service.from('billing_events').insert({
    provider: 'stripe',
    provider_event_id: event.id,
    event_type: event.type,
    payload_hash: await sha256(body),
    payload: event,
  });
  if (error && error.code !== '23505') throw error;
  c.executionCtx.waitUntil(processStripeEvent(c.env, event.id));
  return c.json({ received: true }, 202);
});

export default phase5Public;
