import { useEffect, useMemo, useState } from 'react';
import { api } from './lib/api';

type Program = { id: string; code: string; name: string; status: string; launch_version: string; target_at?: string | null; launched_at?: string | null };
type Checklist = { id: string; launch_program_id: string; item_key: string; category: string; title: string; required: boolean; status: string; summary: string; expires_at?: string | null };
type Control = { environment: string; registration_open: boolean; waitlist_open: boolean; invite_only: boolean; reason: string; opened_at?: string | null };
type Gate = { id: string; launch_program_id: string; status: string; summary: Record<string, unknown>; assessed_at: string; expires_at: string };
type Waitlist = { id: string; status: string; source: string; medium: string; campaign: string; referral_code: string; created_at: string };
type Referral = { id: string; code: string; status: string; created_at: string };
type Experiment = { id: string; experiment_key: string; name: string; surface: string; status: string; primary_metric: string; allocation_percent: number };
type Metric = { metric_date: string; source: string; landing_views: number; waitlist_joins: number; signups: number; activated_workspaces: number; first_publishes: number; paid_workspaces: number; churned_workspaces: number };
type Lifecycle = { id: string; action_type: string; status: string; channel: string; scheduled_for?: string | null; created_at: string };
type Dashboard = { programs: Program[]; checklist: Checklist[]; controls: Control[]; gates: Gate[]; waitlist: Waitlist[]; referrals: Referral[]; experiments: Experiment[]; lifecycle_actions: Lifecycle[]; metrics: Metric[] };

const date = (value?: string | null) => value ? new Date(value).toLocaleString() : '—';

export default function LaunchApp({ onBack, onBeta, onActivation, onReliability }: { onBack: () => void; onBeta: () => void; onActivation: () => void; onReliability: () => void }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [programId, setProgramId] = useState('');
  const [programForm, setProgramForm] = useState({ code: '', name: '', launch_version: '' });
  const [confirmation, setConfirmation] = useState('');
  const [reason, setReason] = useState('Launch gate approved and deployment verified.');
  const [experiment, setExperiment] = useState({ experiment_key: '', name: '', surface: 'landing', hypothesis: '', primary_metric: 'signup_completed', allocation_percent: 100 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    const data = await api<Dashboard>('/api/v10/platform/growth');
    setDashboard(data);
    if (!programId && data.programs[0]) setProgramId(data.programs[0].id);
  };
  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }, []);

  const program = dashboard?.programs.find((item) => item.id === programId);
  const checklist = useMemo(() => dashboard?.checklist.filter((item) => item.launch_program_id === programId) ?? [], [dashboard, programId]);
  const gate = dashboard?.gates.find((item) => item.launch_program_id === programId);
  const control = dashboard?.controls.find((item) => item.environment === 'production');
  const latestMetrics = dashboard?.metrics.slice(0, 14) ?? [];

  const run = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(''); setMessage('');
    try { await work(); setMessage(success); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const createProgram = () => run(async () => {
    const result = await api<Program>('/api/v10/platform/launch-programs', { method: 'POST', body: JSON.stringify(programForm) });
    setProgramId(result.id); setProgramForm({ code: '', name: '', launch_version: '' });
  }, 'Launch program created with required checklist.');

  const updateChecklist = (item: Checklist, status: 'passed' | 'failed') => run(() => api(`/api/v10/platform/launch-programs/${programId}/checklist/${item.item_key}`, { method: 'PUT', body: JSON.stringify({ status, summary: status === 'passed' ? 'Verified by launch operator.' : 'Verification failed and requires remediation.', evidence: { manual: true }, expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString() }) }), `${item.title}: ${status}`);

  const createExperiment = () => run(() => api('/api/v10/platform/growth-experiments', { method: 'POST', body: JSON.stringify({ ...experiment, variants: [{ key: 'control', weight: 1 }, { key: 'variant', weight: 1 }] }) }), 'Growth experiment created in draft.' );

  return <main className="launch-shell">
    <header className="launch-header"><div><p className="launch-kicker">Phase 10 · Public launch & growth</p><h1>Launch Command</h1><p>Open public access only after production activation, closed-beta evidence, restore readiness and every launch obligation pass together.</p></div><div className="launch-nav"><button onClick={onBeta}>Closed Beta</button><button onClick={onActivation}>Activation</button><button onClick={onReliability}>Reliability</button><button onClick={onBack}>Workspace</button></div></header>
    {error && <div className="launch-alert error">{error}</div>}{message && <div className="launch-alert success">{message}</div>}

    <section className="launch-selector"><select value={programId} onChange={(event) => { setProgramId(event.target.value); setConfirmation(''); }}>{dashboard?.programs.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></section>
    <section className="launch-metrics"><div><span>Public registration</span><strong>{control?.registration_open ? 'OPEN' : 'CLOSED'}</strong><small>{control?.reason}</small></div><div><span>Launch gate</span><strong>{gate?.status ?? 'not assessed'}</strong><small>Expires {date(gate?.expires_at)}</small></div><div><span>Waitlist</span><strong>{dashboard?.waitlist.length ?? 0}</strong><small>{dashboard?.waitlist.filter((item) => item.status === 'waiting').length ?? 0} waiting</small></div><div><span>Experiments</span><strong>{dashboard?.experiments.filter((item) => item.status === 'running').length ?? 0}</strong><small>running now</small></div></section>

    <div className="launch-columns"><section className="launch-panel"><h2>Create launch program</h2><input placeholder="launch-code" value={programForm.code} onChange={(event) => setProgramForm({ ...programForm, code: event.target.value })}/><input placeholder="Launch name" value={programForm.name} onChange={(event) => setProgramForm({ ...programForm, name: event.target.value })}/><input placeholder="Version, e.g. 10.0.0" value={programForm.launch_version} onChange={(event) => setProgramForm({ ...programForm, launch_version: event.target.value })}/><button disabled={busy || !programForm.code || !programForm.name || !programForm.launch_version} onClick={() => void createProgram()}>Create program</button></section><section className="launch-panel"><h2>Current program</h2><p><strong>{program?.name ?? 'No program selected'}</strong></p><p>Status: {program?.status ?? '—'} · version {program?.launch_version ?? '—'}</p><p>Target: {date(program?.target_at)} · launched: {date(program?.launched_at)}</p><button disabled={busy || !programId} onClick={() => void run(() => api(`/api/v10/platform/launch-programs/${programId}/assess`, { method: 'POST' }), 'Public launch gate assessed.')}>Assess launch gate</button></section></div>

    <section className="launch-panel"><h2>Required launch checklist</h2><div className="launch-checklist">{checklist.map((item) => <article key={item.id} className={item.status}><div><strong>{item.category.replaceAll('_',' ')}</strong><span>{item.status}</span></div><p>{item.title}</p><small>{item.summary || 'No evidence recorded.'}</small><div><button disabled={busy} onClick={() => void updateChecklist(item, 'passed')}>Pass</button><button disabled={busy} onClick={() => void updateChecklist(item, 'failed')}>Fail</button></div></article>)}</div></section>

    <section className="launch-panel launch-danger"><h2>Public access control</h2><p>Opening registration is transactional and rechecks every live dependency. Pausing access does not delete accounts or data.</p><input value={reason} onChange={(event) => setReason(event.target.value)} /><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={control?.registration_open ? 'PAUSE PUBLIC ACCESS' : 'OPEN PUBLIC ACCESS'} /><div className="launch-row">{control?.registration_open ? <button disabled={busy || confirmation !== 'PAUSE PUBLIC ACCESS'} onClick={() => void run(() => api('/api/v10/platform/launch/pause', { method: 'POST', body: JSON.stringify({ confirmation, reason }) }), 'Public registration paused.')}>Pause public access</button> : <button disabled={busy || gate?.status !== 'passed' || confirmation !== 'OPEN PUBLIC ACCESS'} onClick={() => void run(() => api(`/api/v10/platform/launch-programs/${programId}/open`, { method: 'POST', body: JSON.stringify({ confirmation, reason }) }), 'Public registration opened.')}>Open public access</button>}</div></section>

    <div className="launch-columns"><section className="launch-panel"><h2>Create growth experiment</h2><input placeholder="experiment-key" value={experiment.experiment_key} onChange={(event) => setExperiment({ ...experiment, experiment_key: event.target.value })}/><input placeholder="Experiment name" value={experiment.name} onChange={(event) => setExperiment({ ...experiment, name: event.target.value })}/><select value={experiment.surface} onChange={(event) => setExperiment({ ...experiment, surface: event.target.value })}><option>landing</option><option>pricing</option><option>onboarding</option><option>activation</option><option>referral</option><option>lifecycle</option></select><input placeholder="Primary metric" value={experiment.primary_metric} onChange={(event) => setExperiment({ ...experiment, primary_metric: event.target.value })}/><button disabled={busy || !experiment.experiment_key || !experiment.name} onClick={() => void createExperiment()}>Create draft experiment</button></section><section className="launch-panel"><h2>Experiments</h2><div className="launch-list">{dashboard?.experiments.slice(0,12).map((item) => <div key={item.id}><strong>{item.name}</strong><span>{item.surface} · {item.status}</span><small>{item.primary_metric} · {item.allocation_percent}% allocation</small></div>)}</div></section></div>

    <section className="launch-panel"><h2>Privacy-safe daily funnel</h2><div className="growth-table"><div className="head"><span>Date/source</span><span>Views</span><span>Waitlist</span><span>Signups</span><span>Activated</span><span>Published</span><span>Paid</span></div>{latestMetrics.map((item) => <div key={`${item.metric_date}:${item.source}`}><span>{item.metric_date}<small>{item.source}</small></span><span>{item.landing_views}</span><span>{item.waitlist_joins}</span><span>{item.signups}</span><span>{item.activated_workspaces}</span><span>{item.first_publishes}</span><span>{item.paid_workspaces}</span></div>)}</div></section>
  </main>;
}
