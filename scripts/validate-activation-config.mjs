import fs from 'node:fs';
import path from 'node:path';

const environment = process.argv.find((arg) => arg.startsWith('--environment='))?.split('=')[1] ?? process.env.DEPLOYMENT_ENVIRONMENT;
if (!['staging', 'production'].includes(environment)) throw new Error('Use --environment=staging or --environment=production.');

const required = [
  'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'TOKEN_ENCRYPTION_KEY', 'RATE_LIMIT_SALT', 'CRON_SECRET',
  'WEB_ORIGIN', 'PUBLIC_API_ORIGIN', 'BETA_APP_ORIGIN', 'META_APP_ID', 'META_APP_SECRET',
  'META_REDIRECT_URI', 'META_WEBHOOK_VERIFY_TOKEN', 'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET', 'STRIPE_SUCCESS_URL', 'STRIPE_CANCEL_URL',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_PAGES_PROJECT',
  'SUPABASE_DB_URL',
];

const missing = required.filter((key) => !process.env[key]?.trim());
const errors = missing.map((key) => `${key} is missing.`);
const httpsKeys = ['SUPABASE_URL', 'WEB_ORIGIN', 'PUBLIC_API_ORIGIN', 'BETA_APP_ORIGIN', 'META_REDIRECT_URI', 'STRIPE_SUCCESS_URL', 'STRIPE_CANCEL_URL'];
for (const key of httpsKeys) {
  const value = process.env[key];
  if (!value) continue;
  try {
    if (new URL(value).protocol !== 'https:') errors.push(`${key} must use HTTPS.`);
  } catch {
    errors.push(`${key} is not a valid URL.`);
  }
}

const stripeKey = process.env.STRIPE_SECRET_KEY ?? '';
if (environment === 'production' && !stripeKey.startsWith('sk_live_')) errors.push('Production requires a live Stripe secret key.');
if (environment === 'staging' && !stripeKey.startsWith('sk_test_')) errors.push('Staging requires a Stripe test secret key.');
if ((process.env.PUBLISHING_PROVIDER_MODE ?? 'meta') !== 'meta') errors.push('Publishing provider mode must be meta.');
if ((process.env.BILLING_PROVIDER_MODE ?? 'stripe') !== 'stripe') errors.push('Billing provider mode must be stripe.');
if ((process.env.RATE_LIMIT_SALT ?? '').length < 32) errors.push('RATE_LIMIT_SALT must contain at least 32 characters.');

const migrationDir = path.resolve('supabase/migrations');
const versions = fs.readdirSync(migrationDir).filter((name) => /^\d{4}_.+\.sql$/.test(name)).map((name) => name.slice(0, 4)).sort();
const latestMigration = versions.at(-1);
if (!latestMigration) errors.push('No migrations were found.');
if (process.env.EXPECTED_MIGRATION_VERSION && process.env.EXPECTED_MIGRATION_VERSION !== latestMigration) errors.push(`EXPECTED_MIGRATION_VERSION must equal ${latestMigration}.`);

const output = {
  environment,
  checked_at: new Date().toISOString(),
  latest_migration: latestMigration,
  required_count: required.length,
  missing,
  errors,
  provider_modes: {
    publishing: process.env.PUBLISHING_PROVIDER_MODE ?? 'meta',
    billing: process.env.BILLING_PROVIDER_MODE ?? 'stripe',
    stripe_key_mode: stripeKey.startsWith('sk_live_') ? 'live' : stripeKey.startsWith('sk_test_') ? 'test' : 'unknown',
  },
  origins: {
    web: process.env.WEB_ORIGIN ? new URL(process.env.WEB_ORIGIN).origin : null,
    api: process.env.PUBLIC_API_ORIGIN ? new URL(process.env.PUBLIC_API_ORIGIN).origin : null,
    beta: process.env.BETA_APP_ORIGIN ? new URL(process.env.BETA_APP_ORIGIN).origin : null,
  },
  safety: { rate_limit_salt_configured: Boolean(process.env.RATE_LIMIT_SALT), rate_limit_salt_length_valid: (process.env.RATE_LIMIT_SALT ?? '').length >= 32 },
  ready: errors.length === 0,
};
fs.writeFileSync('activation-preflight.json', `${JSON.stringify(output, null, 2)}\n`);
if (errors.length) {
  console.error(`Activation preflight failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Activation preflight passed for ${environment}; latest migration ${latestMigration}.`);
