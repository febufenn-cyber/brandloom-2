import { useEffect, useMemo, useState } from 'react';
import { api } from './lib/api';

type Environment = 'staging' | 'production';
type Component = { component: string; status: string; current: boolean; summary: string; checked_at?: string | null; expires_at?: string | null };
type Readiness = { environment: Environment; required: number; passed: number; failed: number; ready: boolean; components: Component[] };
type ConfigCheck = { key: string; ok: boolean; status: string; message: string };
type Dashboard = {
  profiles: Array<{ environment: string; status: string; release_id?: string | null; last_checked_at?: string | null; activated_at?: string | null }>;
  runs: Array<{ id: string; environment: string; status: string; source: string; started_at: string; completed_at?: string | null; safe_error?: string }>;
  staging: Readiness;
  production: Readiness;
  configuration: { staging: ConfigCheck[]; production: ConfigCheck[] };
};

const date = (value?: string | null) => value ? new Date(value).toLocaleString() : '—';

export default function ActivationApp({ onBack, onReliability }: { onBack: () => void; onReliability: () => void }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [environment, setEnvironment] = useState<Environment>('staging');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    const data = await api<Dashboard>('/api/v8/platform/activation');
    setDashboard(data);
  };

  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }, []);

  const readiness = dashboard?.[environment];
  const profile = useMemo(() => dashboard?.profiles.find((item) => item.environment === environment), [dashboard, environment]);
  const configuration = dashboard?.configuration[environment] ?? [];

  const action = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(''); setMessage('');
    try { await work(); setMessage(success); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return <main className="activation-shell">
    <header className="activation-header">
      <div><p className="activation-kicker">Phase 8 · Live infrastructure</p><h1>Provider Activation</h1><p>Verify real infrastructure and provider credentials before an environment is marked active.</p></div>
      <div className="activation-actions"><button onClick={onReliability}>Reliability</button><button onClick={onBack}>Workspace</button></div>
    </header>

    <nav className="activation-tabs">
      {(['staging', 'production'] as Environment[]).map((name) => <button key={name} className={environment === name ? 'active' : ''} onClick={() => { setEnvironment(name); setConfirmation(''); }}>{name}</button>)}
    </nav>

    {error && <div className="activation-alert error">{error}</div>}
    {message && <div className="activation-alert success">{message}</div>}

    <section className="activation-hero">
      <div><span>Profile</span><strong>{profile?.status ?? 'not provisioned'}</strong><small>Last checked {date(profile?.last_checked_at)}</small></div>
      <div><span>Readiness</span><strong>{readiness ? `${readiness.passed}/${readiness.required}` : '—'}</strong><small>{readiness?.ready ? 'All evidence is current' : 'Activation remains blocked'}</small></div>
      <div><span>Active release</span><strong>{profile?.release_id ? profile.release_id.slice(0, 12) : 'none'}</strong><small>Activated {date(profile?.activated_at)}</small></div>
    </section>

    <section className="activation-panel">
      <div className="activation-panel-head"><div><h2>Live verification</h2><p>Runs network and database probes. No content is published and no charge is created.</p></div><button disabled={busy} onClick={() => void action(() => api(`/api/v8/platform/activation/${environment}/verify`, { method: 'POST' }), `${environment} verification completed.`)}>Run verification</button></div>
      <div className="activation-grid">
        {(readiness?.components ?? []).map((item) => <article key={item.component} className={`activation-card ${item.current ? 'passed' : item.status}`}>
          <div><h3>{item.component.replaceAll('_', ' ')}</h3><span>{item.current ? 'current' : item.status}</span></div>
          <p>{item.summary}</p><small>Checked {date(item.checked_at)} · Expires {date(item.expires_at)}</small>
        </article>)}
      </div>
    </section>

    <section className="activation-panel">
      <h2>Configuration boundary</h2>
      <div className="activation-config">{configuration.map((item) => <div key={item.key}><span className={item.ok ? 'dot ok' : 'dot'} /><code>{item.key}</code><p>{item.message}</p></div>)}</div>
    </section>

    <section className="activation-panel danger-zone">
      <h2>Explicit activation</h2>
      <p>Activation records the current release and configuration fingerprint. It cannot bypass missing, failed or expired evidence.</p>
      <div className="activation-confirm"><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={`ACTIVATE ${environment.toUpperCase()}`} /><button disabled={busy || !readiness?.ready || confirmation !== `ACTIVATE ${environment.toUpperCase()}`} onClick={() => void action(() => api(`/api/v8/platform/activation/${environment}/activate`, { method: 'POST', body: JSON.stringify({ confirmation }) }), `${environment} was activated.`)}>Activate {environment}</button></div>
    </section>

    <section className="activation-panel"><h2>Recent verification runs</h2><div className="activation-runs">{(dashboard?.runs ?? []).filter((run) => run.environment === environment).slice(0, 10).map((run) => <div key={run.id}><strong>{run.status}</strong><span>{run.source}</span><span>{date(run.started_at)}</span><small>{run.safe_error || date(run.completed_at)}</small></div>)}</div></section>
  </main>;
}
