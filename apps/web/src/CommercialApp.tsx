import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './lib/api';

const money = (amount: number, currency = 'usd') => new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(amount / 100);
const date = (value?: string | null) => value ? new Date(value).toLocaleDateString() : '—';

type Brand = { id: string; workspace_id: string; name: string };
type Plan = { code: 'solo' | 'growth' | 'agency'; name: string; description: string; monthly_amount: number; currency: string; features: string[]; limits: Record<string, number> };
type Dashboard = {
  period: string;
  provider_mode: 'mock' | 'stripe';
  role: string | null;
  plans: Plan[];
  subscription: { plan_code: string; status: string; access_state: string; current_period_end?: string | null; trial_end?: string | null; cancel_at_period_end: boolean } | null;
  entitlement: { plan_code: string; access_state: string; features: Record<string, boolean>; limits: Record<string, number> } | null;
  usage: Array<{ id: string; usage_type: string; quantity: number; created_at: string; metadata?: Record<string, unknown> }>;
  usage_by_type: Record<string, number>;
  active_reservations: number;
  credits: number;
  usage_percent: number;
  controls: { generation_paused: boolean; generation_pause_reason: string } | null;
  exports: Array<{ id: string; status: string; created_at: string; expires_at?: string | null; checksum?: string | null }>;
  deletions: Array<{ id: string; scope: string; status: string; execute_after: string; created_at: string }>;
};

type Tab = 'overview' | 'plans' | 'usage' | 'privacy';

export default function CommercialApp({ onBack, onOperations, onPublishing }: { onBack: () => void; onOperations: () => void; onPublishing: () => void }) {
  const [brand, setBrand] = useState<Brand | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [exportPayload, setExportPayload] = useState<unknown>(null);

  const refresh = async () => {
    const boot = await api<{ brand: Brand | null }>('/api/bootstrap');
    setBrand(boot.brand);
    if (boot.brand) setDashboard(await api<Dashboard>(`/api/v5/workspaces/${boot.brand.workspace_id}/commercial`));
  };

  useEffect(() => {
    void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  useEffect(() => {
    if (!brand) return;
    const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    const token = query.get('mock_checkout');
    if (!token) return;
    setBusy(true);
    void api(`/api/v5/workspaces/${brand.workspace_id}/billing/mock/complete`, { method: 'POST', body: JSON.stringify({ token }) })
      .then(async () => {
        setMessage('Subscription activated in mock billing mode.');
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#commercial`);
        await refresh();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(false));
  }, [brand?.workspace_id]);

  const run = async (task: () => Promise<void>, success?: string) => {
    setBusy(true); setError(''); setMessage('');
    try { await task(); if (success) setMessage(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  if (!brand || !dashboard) return <div className="commercial-loading">{error || 'Loading commercial operations…'}</div>;
  const tabs: Array<[Tab, string]> = [['overview', 'Business health'], ['plans', 'Plans & billing'], ['usage', 'Usage'], ['privacy', 'Data & privacy']];

  const checkout = (planCode: string) => run(async () => {
    const result = await api<{ url: string }>(`/api/v5/workspaces/${brand.workspace_id}/billing/checkout`, { method: 'POST', body: JSON.stringify({ plan_code: planCode }) });
    window.location.href = result.url;
  });

  const portal = () => run(async () => {
    const result = await api<{ url: string }>(`/api/v5/workspaces/${brand.workspace_id}/billing/portal`, { method: 'POST' });
    window.location.href = result.url;
  });

  const exportData = () => run(async () => {
    const job = await api<{ id: string }>(`/api/v5/workspaces/${brand.workspace_id}/exports`, { method: 'POST' });
    const result = await api<{ payload: unknown }>(`/api/v5/export-jobs/${job.id}`);
    setExportPayload(result.payload);
    await refresh();
  }, 'Export package generated.');

  const requestDeletion = () => run(async () => {
    await api(`/api/v5/workspaces/${brand.workspace_id}/deletion-requests`, { method: 'POST', body: JSON.stringify({ scope: 'workspace', reason: 'Requested from the commercial privacy centre.' }) });
    await refresh();
  }, 'Workspace deletion scheduled with a seven-day cooling period.');

  const toggleGeneration = () => run(async () => {
    const next = !dashboard.controls?.generation_paused;
    await api(`/api/v5/workspaces/${brand.workspace_id}/controls`, { method: 'PATCH', body: JSON.stringify({ generation_paused: next, reason: next ? 'Paused manually by a workspace administrator.' : '' }) });
    await refresh();
  }, dashboard.controls?.generation_paused ? 'Generation resumed.' : 'Generation paused.');

  return <div className="commercial-shell">
    <header className="commercial-topbar">
      <div className="commercial-brand"><span>BL</span><div><strong>{brand.name}</strong><small>Commercial operations</small></div></div>
      <div className="commercial-actions"><button onClick={onOperations}>Operations</button><button onClick={onPublishing}>Publishing</button><button onClick={onBack}>Studio</button></div>
    </header>
    <div className="commercial-layout">
      <nav className="commercial-nav">{tabs.map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</nav>
      <main className="commercial-main">
        {(error || message) && <div className={`commercial-alert ${error ? 'error' : ''}`}>{error || message}</div>}
        {tab === 'overview' && <Overview dashboard={dashboard} toggleGeneration={toggleGeneration} busy={busy} />}
        {tab === 'plans' && <Plans dashboard={dashboard} checkout={checkout} portal={portal} busy={busy} />}
        {tab === 'usage' && <Usage dashboard={dashboard} />}
        {tab === 'privacy' && <Privacy dashboard={dashboard} exportData={exportData} requestDeletion={requestDeletion} cancelDeletion={(id) => run(async () => { await api(`/api/v5/deletion-requests/${id}/cancel`, { method: 'POST' }); await refresh(); }, 'Deletion request cancelled.')} busy={busy} exportPayload={exportPayload} />}
      </main>
    </div>
  </div>;
}

function Overview({ dashboard, toggleGeneration, busy }: { dashboard: Dashboard; toggleGeneration: () => Promise<void>; busy: boolean }) {
  const used = Number(dashboard.usage_by_type.generation_units ?? 0);
  const limit = Number(dashboard.entitlement?.limits.monthly_generation_units ?? 0);
  const access = dashboard.subscription?.access_state ?? 'read_only';
  return <section><Head title="Commercial command centre" text="Billing, access, usage and customer data controls converge here." />
    <div className="commercial-grid four"><Metric label="Plan" value={dashboard.subscription?.plan_code ?? 'trial'} /><Metric label="Access" value={access} warning={access !== 'full'} /><Metric label="Usage" value={`${used}/${limit + dashboard.credits}`} /><Metric label="Provider" value={dashboard.provider_mode} /></div>
    <div className="commercial-grid two"><Card><p className="commercial-eyebrow">Current period</p><h2>{dashboard.period}</h2><div className="commercial-progress"><span style={{ width: `${dashboard.usage_percent}%` }} /></div><p>{dashboard.usage_percent}% consumed · {dashboard.active_reservations} units currently reserved.</p><small>Existing drafts, approvals and exports remain available when generation reaches its limit.</small></Card>
      <Card><p className="commercial-eyebrow">Cost circuit</p><h2>{dashboard.controls?.generation_paused ? 'Generation paused' : 'Generation active'}</h2><p>{dashboard.controls?.generation_pause_reason || 'Atomic reservations prevent concurrent requests from overspending the workspace allowance.'}</p><button className={dashboard.controls?.generation_paused ? 'commercial-primary' : 'commercial-danger'} disabled={busy} onClick={() => void toggleGeneration()}>{dashboard.controls?.generation_paused ? 'Resume generation' : 'Pause generation'}</button></Card></div>
    <Card><h2>Subscription lifecycle</h2><div className="commercial-lifecycle"><State active={dashboard.subscription?.status === 'trialing'}>Trial</State><State active={dashboard.subscription?.status === 'active'}>Active</State><State active={dashboard.subscription?.access_state === 'grace'}>Grace</State><State active={dashboard.subscription?.access_state === 'read_only'}>Read only</State></div><p>Trial ends: {date(dashboard.subscription?.trial_end)} · Current period ends: {date(dashboard.subscription?.current_period_end)}</p></Card>
  </section>;
}

function Plans({ dashboard, checkout, portal, busy }: { dashboard: Dashboard; checkout: (planCode: string) => Promise<void>; portal: () => Promise<void>; busy: boolean }) {
  return <section><Head title="Plans and billing" text="One workspace plan controls brands, seats, generation capacity, publishing and support." />
    <div className="commercial-provider-note">Provider mode: <strong>{dashboard.provider_mode}</strong>. Mock mode exercises the full entitlement lifecycle without charging a card.</div>
    <div className="commercial-plan-grid">{dashboard.plans.map((plan) => <article className={`commercial-plan ${dashboard.subscription?.plan_code === plan.code ? 'current' : ''}`} key={plan.code}><p className="commercial-eyebrow">{plan.name}</p><h2>{money(plan.monthly_amount, plan.currency)}<small>/month</small></h2><p>{plan.description}</p><ul>{plan.features.map((feature) => <li key={feature}>{feature}</li>)}</ul><div className="commercial-plan-limits"><span>{plan.limits.monthly_generation_units} generation units</span><span>{plan.limits.brands} brand{plan.limits.brands === 1 ? '' : 's'}</span><span>{plan.limits.members} members</span></div><button className="commercial-primary" disabled={busy || dashboard.subscription?.plan_code === plan.code} onClick={() => void checkout(plan.code)}>{dashboard.subscription?.plan_code === plan.code ? 'Current plan' : `Choose ${plan.name}`}</button></article>)}</div>
    <Card><div className="commercial-row"><div><h2>Manage payment details</h2><p>Open the provider portal to update payment methods, invoices, cancellation or renewal settings.</p></div><button disabled={busy} onClick={() => void portal()}>Open billing portal</button></div></Card>
  </section>;
}

function Usage({ dashboard }: { dashboard: Dashboard }) {
  const grouped = useMemo(() => Object.entries(dashboard.usage_by_type).sort((a, b) => b[1] - a[1]), [dashboard.usage_by_type]);
  return <section><Head title="Usage ledger" text="Usage is append-only. Retries use idempotency keys, and failed requests release their reservations." />
    <div className="commercial-grid three"><Metric label="Generation units" value={String(dashboard.usage_by_type.generation_units ?? 0)} /><Metric label="Reserved" value={String(dashboard.active_reservations)} /><Metric label="Credits" value={String(dashboard.credits)} /></div>
    <div className="commercial-grid two"><Card><h2>By operation</h2>{grouped.length ? grouped.map(([key, value]) => <div className="commercial-usage-row" key={key}><span>{key.replaceAll('_', ' ')}</span><strong>{value}</strong></div>) : <p>No billable operations this period.</p>}</Card><Card><h2>Recent entries</h2>{dashboard.usage.slice(0, 12).map((entry) => <div className="commercial-usage-row" key={entry.id}><span>{new Date(entry.created_at).toLocaleString()}</span><strong>{entry.quantity}</strong></div>)}{dashboard.usage.length === 0 && <p>No usage recorded.</p>}</Card></div>
  </section>;
}

function Privacy({ dashboard, exportData, requestDeletion, cancelDeletion, busy, exportPayload }: { dashboard: Dashboard; exportData: () => Promise<void>; requestDeletion: () => Promise<void>; cancelDeletion: (id: string) => Promise<void>; busy: boolean; exportPayload: unknown }) {
  const pending = dashboard.deletions.find((item) => item.status === 'scheduled');
  return <section><Head title="Data and privacy" text="Customers can export their workspace, disconnect services and schedule deletion without contacting support." />
    <div className="commercial-grid two"><Card><p className="commercial-eyebrow">Portable data</p><h2>Workspace export</h2><p>Exports include brands, products, audiences, memories, campaigns, content, publishing audit and usage history.</p><button className="commercial-primary" disabled={busy} onClick={() => void exportData()}>Generate export</button>{dashboard.exports.map((item) => <div className="commercial-export" key={item.id}><span>{item.status} · {date(item.created_at)}</span><small>{item.checksum?.slice(0, 16) ?? 'Preparing checksum'}</small></div>)}</Card>
      <Card danger><p className="commercial-eyebrow">Deletion lifecycle</p><h2>{pending ? 'Deletion scheduled' : 'Delete workspace'}</h2>{pending ? <><p>Execution becomes eligible on {new Date(pending.execute_after).toLocaleString()}. Generation is paused while the request is pending.</p><button disabled={busy} onClick={() => void cancelDeletion(pending.id)}>Cancel deletion</button></> : <><p>A seven-day cooling period prevents accidental loss. Provider credentials and future publishing must be revoked before execution.</p><button className="commercial-danger" disabled={busy} onClick={() => void requestDeletion()}>Schedule workspace deletion</button></>}</Card></div>
    {exportPayload !== null && <Card><h2>Latest export payload</h2><pre className="commercial-json">{JSON.stringify(exportPayload, null, 2)}</pre></Card>}
  </section>;
}

function Head({ title, text }: { title: string; text: string }) { return <header className="commercial-head"><p className="commercial-eyebrow">Phase 5 · Commercial production</p><h1>{title}</h1><p>{text}</p></header>; }
function Card({ children, danger = false }: { children: ReactNode; danger?: boolean }) { return <article className={`commercial-card ${danger ? 'danger-zone' : ''}`}>{children}</article>; }
function Metric({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) { return <div className={`commercial-metric ${warning ? 'warning' : ''}`}><strong>{value}</strong><span>{label}</span></div>; }
function State({ children, active }: { children: ReactNode; active: boolean }) { return <span className={active ? 'active' : ''}>{children}</span>; }
