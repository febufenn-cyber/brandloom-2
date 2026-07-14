import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const migrationFiles = fs.readdirSync('supabase/migrations').filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
const testFiles = fs.readdirSync('apps/api/test').filter((name) => name.endsWith('.test.ts')).sort();
const inputs = [...migrationFiles.map((name) => path.join('supabase/migrations', name)), ...testFiles.map((name) => path.join('apps/api/test', name))];
const manifest = {
  generated_at: new Date().toISOString(),
  commit_sha: process.env.GITHUB_SHA ?? process.env.COMMIT_SHA ?? 'local',
  latest_migration: migrationFiles.at(-1)?.slice(0, 4) ?? null,
  migration_count: migrationFiles.length,
  test_file_count: testFiles.length,
  security_report: fs.existsSync('security-static-report.json') ? JSON.parse(fs.readFileSync('security-static-report.json', 'utf8')) : null,
  files: inputs.map((file) => ({ file, sha256: hashFile(file) })),
};
const checksum = crypto.createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex');
fs.writeFileSync('beta-qa-manifest.json', `${JSON.stringify({ ...manifest, checksum }, null, 2)}\n`);
console.log(`Created beta QA manifest ${checksum}.`);
