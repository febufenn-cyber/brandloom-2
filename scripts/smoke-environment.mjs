import fs from 'node:fs';

const environment = process.argv.find((arg) => arg.startsWith('--environment='))?.split('=')[1] ?? process.env.DEPLOYMENT_ENVIRONMENT;
const apiOrigin = (process.env.PUBLIC_API_ORIGIN ?? '').replace(/\/$/, '');
const webOrigin = (process.env.WEB_ORIGIN ?? '').replace(/\/$/, '');
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
const result = { environment, checked_at: new Date().toISOString(), checks, passed: checks.every((check) => check.ok) };
fs.writeFileSync('deployment-smoke.json', `${JSON.stringify(result, null, 2)}\n`);
for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name} ${check.status} ${check.latency_ms}ms`);
if (!result.passed) process.exit(1);
