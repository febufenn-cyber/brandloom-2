import { Hono } from 'hono';
import { completeOAuthCallback } from './connectionService';
import { sha256Hex, verifyHmacSha256 } from './crypto';
import { createServiceClient } from './db';
import { dispatchDuePublications } from './publicationService';
import type { Env } from './types';

const publicRoutes = new Hono<{ Bindings: Env }>();

function callbackHtml(origin: string, result: { ok: boolean; message: string }) {
  const payload = JSON.stringify({ type: 'brandloom-meta-connection', ...result }).replaceAll('<', '\\u003c');
  return `<!doctype html><html><body><p>${result.message}</p><script>
    if (window.opener) window.opener.postMessage(${payload}, ${JSON.stringify(origin)});
    setTimeout(() => { window.location.href = ${JSON.stringify(`${origin}/#publishing`)}; }, 600);
  </script></body></html>`;
}

publicRoutes.get('/integrations/meta/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const origin = c.env.WEB_ORIGIN ?? 'http://localhost:5173';
  if (!code || !state) return c.html(callbackHtml(origin, { ok: false, message: 'Meta did not return a valid authorization response.' }), 400);
  try {
    const result = await completeOAuthCallback(c.env, code, state);
    return c.html(callbackHtml(origin, { ok: true, message: `Connected @${result.account.username || result.account.provider_account_id}. Return to Brandloom to confirm the destination.` }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Connection failed.';
    return c.html(callbackHtml(origin, { ok: false, message }), 400);
  }
});

publicRoutes.get('/webhooks/meta', (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');
  if (mode === 'subscribe' && token && token === c.env.META_WEBHOOK_VERIFY_TOKEN) return c.text(challenge ?? '');
  return c.text('Webhook verification failed.', 403);
});

publicRoutes.post('/webhooks/meta', async (c) => {
  const raw = await c.req.text();
  const signatureValid = await verifyHmacSha256(raw, c.req.header('x-hub-signature-256'), c.env.META_APP_SECRET ?? '');
  if (!signatureValid) return c.json({ error: 'Invalid webhook signature.' }, 401);
  const eventKey = await sha256Hex(`${c.req.header('x-hub-signature-256')}:${raw}`);
  const payload = JSON.parse(raw) as Record<string, unknown>;
  const service = createServiceClient(c.env);
  const { error } = await service.from('provider_webhook_events').upsert({
    provider: 'meta_instagram', event_key: eventKey, event_type: String(payload.object ?? ''),
    signature_valid: true, payload, status: 'received',
  }, { onConflict: 'event_key', ignoreDuplicates: true });
  if (error) throw error;
  return c.json({ received: true });
});

publicRoutes.post('/internal/publications/dispatch', async (c) => {
  if (!c.env.CRON_SECRET || c.req.header('Authorization') !== `Bearer ${c.env.CRON_SECRET}`) return c.json({ error: 'Unauthorized.' }, 401);
  return c.json(await dispatchDuePublications(c.env));
});

export default publicRoutes;
