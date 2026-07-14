import fs from 'node:fs';

const environment = process.argv.find((arg) => arg.startsWith('--environment='))?.split('=')[1] ?? process.env.DEPLOYMENT_ENVIRONMENT;
const apiOrigin = (process.env.PUBLIC_API_ORIGIN ?? '').replace(/\/$/, '');
const webOrigin = (process.env.WEB_ORIGIN ?? '').replace(/\/$/, '');
const allowNotReady = process.env.ALLOW_NOT_READY === 'true';
if (!['staging', 'production'].includes(environment)) throw new Error('DEPLOYMENT_ENVIRONMENT must be staging or production.');
if (!apiOrigin || !webOrigin) throw new Error('PUBLIC_API_ORIGIN and WEB_ORIGIN are required.');

async function probe(name, url, options = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, { redirect: 'follow', ...options });
    const body = await response.text();
    return {
      name,
      url: new URL(response.url || url).origin + new URL(response.url || url).pathname,
      status: response.status,
      ok: response.ok,
      latency_ms: Date.now() - started,
      body_sample: body.slice(0, 300),
    };
  } catch (error) {
    return { name, url, status: 0, ok: false, latency_ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

const checks = await Promise.all([
  probe('api_liveness', `${apiOrigin}/health/live`),
  probe('api_readiness', `${apiOrigin}/health/ready`),
  probe('web', webOrigin),
]);
const liveness = checks.find((check) => check.name === 'api_liveness');
const readiness = checks.find((check) => check.name === 'api_readiness');
const web = checks.find((check) => check.name === 'web');
const passed = Boolean(liveness?.ok && web?.ok && (readiness?.ok || allowNotReady));
const result = { environment, checked_at: new Date().toISOString(), allow_not_ready: allowNotReady, checks, passed };
fs.writeFileSync('deployment-smoke.json', `${JSON.stringify(result, null, 2)}\n`);
for (const check of checks) {
  const accepted = check.ok || (allowNotReady && check.name === 'api_readiness');
  console.log(`${accepted ? 'PASS' : 'FAIL'} ${check.name} ${check.status} ${check.latency_ms}ms${!check.ok && accepted ? ' (pre-promotion)' : ''}`);
}
if (!result.passed) process.exit(1);
