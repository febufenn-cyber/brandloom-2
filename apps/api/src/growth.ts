export const REQUIRED_LAUNCH_CATEGORIES = ['product','security','legal','support','operations','billing','publishing','data_rights','communications'] as const;

export type LaunchChecklist = { category: string; required: boolean; status: string; expires_at?: string | null };
export type LaunchGateInput = {
  activeRelease: boolean;
  productionActivation: boolean;
  betaGateCurrent: boolean;
  restoreDrillCurrent: boolean;
  checklist: LaunchChecklist[];
  blockingFindings: number;
  blockingIncidents: number;
};

function current(item: { expires_at?: string | null }, now: Date) {
  if (!item.expires_at) return true;
  const value = new Date(item.expires_at).getTime();
  return Number.isFinite(value) && value > now.getTime();
}

export function evaluatePublicLaunchGate(input: LaunchGateInput, now = new Date()) {
  const required = input.checklist.filter((item) => item.required);
  const categories = REQUIRED_LAUNCH_CATEGORIES.map((category) => {
    const items = required.filter((item) => item.category === category);
    return { category, total: items.length, passed: items.filter((item) => ['passed','waived'].includes(item.status) && current(item, now)).length };
  });
  const checklistReady = required.length > 0 && required.every((item) => ['passed','waived'].includes(item.status) && current(item, now));
  return {
    active_release: input.activeRelease,
    production_activation: input.productionActivation,
    beta_gate_current: input.betaGateCurrent,
    restore_drill_current: input.restoreDrillCurrent,
    checklist_required: required.length,
    checklist_passed: required.filter((item) => ['passed','waived'].includes(item.status) && current(item, now)).length,
    categories,
    blocking_findings: input.blockingFindings,
    blocking_incidents: input.blockingIncidents,
    ready: input.activeRelease && input.productionActivation && input.betaGateCurrent && input.restoreDrillCurrent && checklistReady && input.blockingFindings === 0 && input.blockingIncidents === 0,
  };
}

export function sanitizeAttribution(value: string | undefined, max = 120) {
  return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9._~+-]/g, '-').replace(/-+/g, '-').slice(0, max);
}

export function sanitizeGrowthProperties(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeGrowthProperties(item, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).filter(([key]) => !/email|phone|name|address|token|secret|password|cookie|authorization|ip/i.test(key)).map(([key,item]) => [key, sanitizeGrowthProperties(item, depth + 1)]));
  return undefined;
}

function fnv1a(value: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function assignGrowthVariant(subjectHash: string, experimentKey: string, variants: Array<{ key: string; weight?: number }>, allocationPercent = 100) {
  if (!variants.length) return null;
  const allocationBucket = fnv1a(`${experimentKey}:allocation:${subjectHash}`) % 100;
  if (allocationBucket >= Math.min(Math.max(allocationPercent, 1), 100)) return null;
  const normalized = variants.map((variant) => ({ ...variant, weight: Math.max(1, variant.weight ?? 1) }));
  const total = normalized.reduce((sum, variant) => sum + variant.weight, 0);
  let bucket = fnv1a(`${experimentKey}:variant:${subjectHash}`) % total;
  for (const variant of normalized) {
    if (bucket < variant.weight) return variant.key;
    bucket -= variant.weight;
  }
  return normalized[0]?.key ?? null;
}

export function funnelRates(input: { landing_views: number; waitlist_joins: number; signups: number; activated_workspaces: number; first_publishes: number; paid_workspaces: number }) {
  const rate = (numerator: number, denominator: number) => denominator > 0 ? Math.round((numerator / denominator) * 10000) / 10000 : 0;
  return {
    waitlist_rate: rate(input.waitlist_joins, input.landing_views),
    signup_rate: rate(input.signups, input.landing_views),
    activation_rate: rate(input.activated_workspaces, input.signups),
    first_publish_rate: rate(input.first_publishes, input.activated_workspaces),
    paid_conversion_rate: rate(input.paid_workspaces, input.signups),
  };
}

export function validReferralCode(code: string) {
  return /^[A-Z0-9]{6,20}$/.test(code);
}
