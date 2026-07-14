import crypto from 'node:crypto';
import fs from 'node:fs';

const files = [
  'docs/PHASE7.md','docs/PHASE8.md','docs/PHASE9.md','docs/PHASE10.md',
  'docs/security/closed-beta-runbook.md','docs/launch/public-launch-runbook.md',
  'supabase/migrations/0020_phase10_public_launch_growth.sql',
  'supabase/migrations/0021_phase10_launch_integrity.sql',
  'supabase/migrations/0022_phase10_signup_gate.sql',
  'apps/api/test/growth.test.ts','apps/web/public/_headers',
];
const missing = files.filter((file) => !fs.existsSync(file));
if (missing.length) {
  for (const file of missing) console.error(`Missing launch artifact: ${file}`);
  process.exit(1);
}
const artifacts = files.map((file) => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const manifest = {
  generated_at: new Date().toISOString(),
  commit_sha: process.env.GITHUB_SHA ?? process.env.COMMIT_SHA ?? 'local',
  migration_target: '0022',
  public_access_default: 'closed',
  requires_explicit_confirmation: 'OPEN PUBLIC ACCESS',
  external_launch_claimed: false,
  artifacts,
};
const checksum = crypto.createHash('sha256').update(JSON.stringify(artifacts)).digest('hex');
fs.writeFileSync('launch-readiness-manifest.json', `${JSON.stringify({ ...manifest, checksum }, null, 2)}\n`);
console.log(`Created launch readiness manifest ${checksum}.`);
