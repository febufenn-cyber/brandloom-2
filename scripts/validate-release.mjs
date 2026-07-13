import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDirectory = path.join(root, 'supabase', 'migrations');
const migrationFiles = (await readdir(migrationsDirectory)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
const failures = [];

const numbers = migrationFiles.map((file) => Number(file.slice(0, 4)));
const duplicates = numbers.filter((value, index) => numbers.indexOf(value) !== index);
if (duplicates.length) failures.push(`Duplicate migration numbers: ${[...new Set(duplicates)].join(', ')}`);
for (let expected = 1; expected <= numbers.length; expected += 1) {
  if (!numbers.includes(expected)) failures.push(`Missing migration ${String(expected).padStart(4, '0')}`);
}
const latest = numbers.length ? String(Math.max(...numbers)).padStart(4, '0') : '0000';
if (Number(latest) < 15) failures.push(`Phase 7 requires migration 0015; latest discovered migration is ${latest}.`);

const wranglerPath = path.join(root, 'apps', 'api', 'wrangler.toml');
const wrangler = await readFile(wranglerPath, 'utf8');
const expectedMatch = wrangler.match(/EXPECTED_MIGRATION_VERSION\s*=\s*"(\d{4})"/);
if (!expectedMatch || expectedMatch[1] !== latest) failures.push(`Wrangler EXPECTED_MIGRATION_VERSION must equal ${latest}.`);
if (!wrangler.includes('DEPLOYMENT_ENVIRONMENT = "local"')) failures.push('Wrangler must default to the local deployment environment.');
if (!wrangler.includes('PUBLISHING_PROVIDER_MODE = "mock"') || !wrangler.includes('BILLING_PROVIDER_MODE = "mock"')) failures.push('Local Wrangler defaults must keep external providers in mock mode.');

const requiredFiles = [
  'docs/PHASE7.md',
  'docs/PRODUCTION_RUNBOOK.md',
  'docs/INCIDENT_RUNBOOK.md',
  '.github/workflows/release-readiness.yml',
];
for (const relative of requiredFiles) {
  try {
    if (!(await stat(path.join(root, relative))).isFile()) failures.push(`${relative} is not a file.`);
  } catch {
    failures.push(`Missing required release artifact: ${relative}`);
  }
}

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!packageJson.scripts?.['release:manifest']) failures.push('package.json is missing release:manifest.');
if (!packageJson.scripts?.check?.includes('release:validate')) failures.push('The main check script must run release:validate.');

const result = {
  ok: failures.length === 0,
  migrations: { count: migrationFiles.length, latest, files: migrationFiles },
  required_files: requiredFiles,
  failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);
