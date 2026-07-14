import fs from 'node:fs';
import path from 'node:path';

const roots = ['apps/api/src', 'apps/web/src', '.github/workflows'];
const textExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.yml', '.yaml', '.toml']);
const files = [];
for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  const visit = (entry) => {
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
    else if (textExtensions.has(path.extname(entry))) files.push(entry);
  };
  visit(root);
}

const failures = [];
const warnings = [];
const secretPatterns = [
  /sk_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /whsec_[A-Za-z0-9]{16,}/g,
  /(?:eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  for (const pattern of secretPatterns) {
    const matches = content.match(pattern) ?? [];
    for (const match of matches) {
      const placeholder = /example|YOUR_|dummy|test_123|live_123/i.test(match);
      if (!placeholder) failures.push(`${file}: possible embedded credential ${match.slice(0, 12)}…`);
    }
  }
  if (file.includes('apps/web') && /SUPABASE_SERVICE_ROLE_KEY|STRIPE_SECRET_KEY|META_APP_SECRET|ANTHROPIC_API_KEY/.test(content)) {
    failures.push(`${file}: server-only secret identifier referenced by browser code.`);
  }
  if (/origin:\s*['"]\*['"]|Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*/.test(content)) {
    failures.push(`${file}: wildcard CORS configuration detected.`);
  }
  if (/console\.(?:log|debug)\([^\n]*(?:token|secret|authorization|password)/i.test(content)) {
    failures.push(`${file}: possible secret-bearing console output.`);
  }
}

for (const required of [
  'supabase/migrations/0018_phase9_security_closed_beta.sql',
  'supabase/migrations/0019_phase9_security_integrity.sql',
  'apps/api/src/securityGuard.ts',
  'apps/web/public/_headers',
]) {
  if (!fs.existsSync(required)) failures.push(`${required}: required security artifact is missing.`);
}

const envExample = fs.readFileSync('.env.example', 'utf8');
for (const key of ['RATE_LIMIT_SALT', 'BETA_APP_ORIGIN']) if (!envExample.includes(`${key}=`)) warnings.push(`${key} is not documented in .env.example.`);

const report = {
  checked_at: new Date().toISOString(),
  files_scanned: files.length,
  failures,
  warnings,
  passed: failures.length === 0,
};
fs.writeFileSync('security-static-report.json', `${JSON.stringify(report, null, 2)}\n`);
for (const warning of warnings) console.warn(`WARN ${warning}`);
for (const failure of failures) console.error(`FAIL ${failure}`);
if (failures.length) process.exit(1);
console.log(`Security static checks passed across ${files.length} files.`);
