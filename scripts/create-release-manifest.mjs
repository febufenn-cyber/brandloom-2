import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const environment = value('environment', process.env.DEPLOYMENT_ENVIRONMENT ?? 'staging');
const version = value('version', process.env.RELEASE_VERSION ?? 'unversioned');
const commitSha = value('commit', process.env.GITHUB_SHA ?? process.env.COMMIT_SHA ?? 'unknown');
const output = path.resolve(root, value('out', 'release-manifest.json'));
if (!['local', 'staging', 'production'].includes(environment)) throw new Error(`Unsupported environment: ${environment}`);

const digest = (content) => createHash('sha256').update(content).digest('hex');
async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}
async function hashDirectory(relative) {
  const directory = path.join(root, relative);
  if (!(await stat(directory)).isDirectory()) throw new Error(`${relative} has not been built.`);
  const hash = createHash('sha256');
  const files = await filesUnder(directory);
  for (const file of files) {
    hash.update(path.relative(directory, file).replaceAll(path.sep, '/'));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return { path: relative, files: files.length, sha256: hash.digest('hex') };
}

const migrationDirectory = path.join(root, 'supabase', 'migrations');
const migrationFiles = (await readdir(migrationDirectory)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
const migrationHash = createHash('sha256');
for (const file of migrationFiles) {
  migrationHash.update(file);
  migrationHash.update('\0');
  migrationHash.update(await readFile(path.join(migrationDirectory, file)));
  migrationHash.update('\0');
}
const latestMigration = migrationFiles.at(-1)?.slice(0, 4) ?? '0000';
const [api, web] = await Promise.all([hashDirectory('apps/api/dist'), hashDirectory('apps/web/dist')]);
const lockfileHash = digest(await readFile(path.join(root, 'pnpm-lock.yaml')));
const core = {
  schema_version: 1,
  environment,
  version,
  commit_sha: commitSha,
  migration_version: latestMigration,
  migrations_sha256: migrationHash.digest('hex'),
  lockfile_sha256: lockfileHash,
  components: { api, web },
};
const artifactChecksum = digest(JSON.stringify(core));
const manifest = { ...core, artifact_checksum: artifactChecksum, generated_at: new Date().toISOString() };
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output: path.relative(root, output), artifact_checksum: artifactChecksum, migration_version: latestMigration }, null, 2));
