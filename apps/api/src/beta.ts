export const REQUIRED_BETA_QA_SUITES = ['auth', 'rls', 'publishing', 'billing', 'data_rights', 'reliability', 'security'] as const;
export type BetaQaSuite = typeof REQUIRED_BETA_QA_SUITES[number] | 'generation' | 'accessibility' | 'performance';
export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low' | 'informational';

export type BetaGateInput = {
  activationActive: boolean;
  qaRuns: Array<{ suite: string; status: string; completed_at?: string | null; expires_at?: string | null }>;
  openFindings: Array<{ severity: SecuritySeverity; status: string }>;
  openIncidents: Array<{ severity: string; status: string }>;
  programStatus: string;
};

function current(run: { expires_at?: string | null }, now: Date) {
  if (!run.expires_at) return true;
  const expires = new Date(run.expires_at).getTime();
  return Number.isFinite(expires) && expires > now.getTime();
}

export function evaluateBetaGate(input: BetaGateInput, now = new Date()) {
  const latest = new Map<string, BetaGateInput['qaRuns'][number]>();
  for (const run of input.qaRuns) {
    if (!REQUIRED_BETA_QA_SUITES.includes(run.suite as typeof REQUIRED_BETA_QA_SUITES[number])) continue;
    const existing = latest.get(run.suite);
    const time = new Date(run.completed_at ?? 0).getTime();
    const existingTime = new Date(existing?.completed_at ?? 0).getTime();
    if (!existing || time > existingTime) latest.set(run.suite, run);
  }
  const suites = REQUIRED_BETA_QA_SUITES.map((suite) => {
    const run = latest.get(suite);
    return { suite, passed: Boolean(run && run.status === 'passed' && current(run, now)), status: run?.status ?? 'missing', expires_at: run?.expires_at ?? null };
  });
  const blockingFindings = input.openFindings.filter((finding) => ['critical', 'high'].includes(finding.severity) && !['mitigated', 'accepted', 'closed', 'false_positive'].includes(finding.status));
  const blockingIncidents = input.openIncidents.filter((incident) => ['sev1', 'sev2'].includes(incident.severity) && !['resolved', 'cancelled'].includes(incident.status));
  const programReady = ['recruiting', 'active'].includes(input.programStatus);
  return {
    activation_active: input.activationActive,
    suites,
    qa_passed: suites.filter((suite) => suite.passed).length,
    qa_required: suites.length,
    blocking_findings: blockingFindings.length,
    blocking_incidents: blockingIncidents.length,
    program_ready: programReady,
    ready: input.activationActive && suites.every((suite) => suite.passed) && blockingFindings.length === 0 && blockingIncidents.length === 0 && programReady,
  };
}

export function securitySeverityWeight(severity: SecuritySeverity) {
  return { critical: 100, high: 40, medium: 15, low: 5, informational: 1 }[severity];
}

export function rateLimitPolicy(method: string, path: string) {
  const normalized = method.toUpperCase();
  if (normalized === 'GET' || normalized === 'HEAD' || normalized === 'OPTIONS') return null;
  if (/\/oauth|\/invites|\/checkout|\/password|\/auth/.test(path)) return { scope: 'identity', limit: 12, windowSeconds: 60 };
  if (/generate|regenerate|\/brief/.test(path)) return { scope: 'generation', limit: 20, windowSeconds: 60 };
  if (/publication|publishing|schedule/.test(path)) return { scope: 'publishing', limit: 30, windowSeconds: 60 };
  return { scope: 'mutation', limit: 120, windowSeconds: 60 };
}

const SECRET_KEYS = /token|secret|password|authorization|cookie|service.role|api.key|access.key/i;

export function sanitizeBetaContext(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (typeof value === 'string') return value.slice(0, 1000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeBetaContext(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 60).map(([key, item]) => [key, SECRET_KEYS.test(key) ? '[redacted]' : sanitizeBetaContext(item, depth + 1)]));
  }
  return String(value).slice(0, 200);
}

export function inviteExpiresAt(hours = 72, now = new Date()) {
  const bounded = Math.min(Math.max(hours, 1), 24 * 14);
  return new Date(now.getTime() + bounded * 3_600_000).toISOString();
}
