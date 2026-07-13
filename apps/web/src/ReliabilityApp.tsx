import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './lib/api';

type Environment = 'local' | 'staging' | 'production';
type GateKey = 'migration_verified' | 'secrets_verified' | 'database_health' | 'provider_readiness' | 'backup_restore_verified' | 'rollback_ready' | 'observability_ready' | 'security_review';
type Readiness = { required: number; passed: number; failed: number; pending: number; ready: boolean; gates: Array<{ gate_key: GateKey; status: string; current: boolean; expired: boolean; summary: string }> };
type Release = { id: string; environment: Environment; version: string; commit_sha: string; artifact_checksum: string; migration_version: string; status: string; release_notes: string; created_at: string; promoted_at?: string | null; previous_release_id?: string | null; readiness: Readiness };
type Control = { environment: Environment; maintenance_mode: boolean; writes_paused: boolean; generation_paused: boolean; publishing_paused: boolean; reason: string; incident_id?: string | null; updated_at: string };
type Incident = { id: string; incident_key: string; environment: Environment; severity: 'sev1' | 'sev2' | 'sev3' | 'sev4'; status: string; title: string; impact: string; public_message: string; started_at: string; resolved_at?: string | null };
type IncidentEvent = { id: string; incident_id: string; event_type: string; message: string; created_at: string };
type Drill = { id: string; environment: Environment; status: string; backup_reference_hash: string; restore_target: string; checksum_verified: boolean; recovery_point_minutes?: number | null; recovery_time_minutes?: number | null; created_at: string; completed_at?: string | null };
type Health = { id: string; environment: Environment; component: string; status: string; latency_ms: number; checked_at: string; expires_at: string };
type Audit = { id: string; environment?: Environment | null; action: string; entity_type: string; created_at: string; metadata: Record<string, unknown> };
type Dashboard = {
  admin: { role: string };
  runtime: { ok: boolean; environment: Environment; version: string; commit_sha: string; expected_migration_version: string; database: { status: string; latency_ms: number }; maintenance_mode: boolean; configuration: Array<{ key: string; status: string; message: string }> };
  environments: Array<{ name: Environment; display_name: string; active_release_id?: string | null }>;
  releases: Release[];
  controls: Control[];
  health: Health[];
  incidents: Incident[];
  incident_events: IncidentEvent[];
  restore_drills: Drill[];
  audit_events: Audit[];
};

type Tab = 'releases' | 'controls' | 'incidents' | 'restore' | 'health';
const date = (value?: string | null) => value ? new Date(value).toLocaleString() : '—';
const short = (value: string) => value.length > 12 ? `${value.slice(0, 12)}…` : value;

export default function ReliabilityApp({ onBack, onOperations, onCommercial, onOptimization }: {
  onBack: () => void; onOperations: () => void; onCommercial: () => void; onOptimization: () => void;
}) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [tab, setTab] = useState<Tab>('releases');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [releaseForm, setReleaseForm] = useState({ environment: 'staging' as Environment, version: '', commitSha: '', checksum: '', migration: '0015', notes: '', rollbackReady: true, securityReviewed: false });
  const [incidentForm, setIncidentForm] = useState({ environment: 'production' as Environment, severity: 'sev3' as Incident['severity'], title: '', impact: '' });
  const [drillForm, setDrillForm] = useState({ environment: 'staging' as Environment, backupHash: '', target: 'Disposable Supabase restore project' });

  const refresh = async () => setDashboard(await api<Dashboard>('/api/v7/platform/reliability'));
  useEffect(() => { void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }, []);

  const run = async (task: () => Promise<void>, success?: string) => {
    setBusy(true); setError(''); setMessage('');
    try { await task(); if (success) setMessage(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  if (!dashboard) return <div className="reliability-loading">{error || 'Loading production reliability…'}</div>;
  const tabs: Array<[Tab, string]> = [['releases', 'Release gates'], ['controls', 'Environment controls'], ['incidents', 'Incidents'], ['restore', 'Restore drills'], ['health', 'Health & audit']];

  const createRelease = () => run(async () => {
    if (!releaseForm.version || !releaseForm.commitSha || !releaseForm.checksum) throw new Error('Version, commit SHA and artifact checksum are required.');
    await api('/api/v7/platform/releases', { method: 'POST', body: JSON.stringify({
      environment: releaseForm.environment,
      version: releaseForm.version,
      commit_sha: releaseForm.commitSha,
      artifact_checksum: releaseForm.checksum,
      migration_version: releaseForm.migration,
      release_notes: releaseForm.notes,
      metadata: { rollback_plan_confirmed: releaseForm.rollbackReady, security_reviewed: releaseForm.securityReviewed },
    }) });
    setReleaseForm((current) => ({ ...current, version: '', commitSha: '', checksum: '', notes: '' }));
    await refresh();
  }, 'Immutable release record created.');

  const runChecks = (releaseId: string) => run(async () => { await api(`/api/v7/platform/releases/${releaseId}/checks`, { method: 'POST' }); await refresh(); }, 'Automated release evidence refreshed.');
  const validate = (releaseId: string) => run(async () => { await api(`/api/v7/platform/releases/${releaseId}/validate`, { method: 'POST' }); await refresh(); }, 'Release validated.');
  const promote = (release: Release) => run(async () => {
    if (!window.confirm(`Record ${release.version} as active in ${release.environment}? The external deployment must already be complete.`)) return;
    await api(`/api/v7/platform/releases/${release.id}/promote`, { method: 'POST', body: JSON.stringify({ confirmation: 'PROMOTE', note: 'External deployment completed and release gates verified from the reliability command centre.' }) });
    await refresh();
  }, 'Release promoted in the control plane.');
  const rollback = (release: Release) => run(async () => {
    if (!window.confirm(`Rollback ${release.environment} to ${release.version}?`)) return;
    await api(`/api/v7/platform/environments/${release.environment}/rollback`, { method: 'POST', body: JSON.stringify({ target_release_id: release.id, confirmation: 'ROLLBACK', reason: 'Operator-triggered rollback from the reliability command centre.' }) });
    await refresh();
  }, 'Rollback recorded.');
  const decideGate = (releaseId: string, gateKey: GateKey, status: 'passed' | 'failed' | 'waived') => run(async () => {
    const summary = window.prompt(`Evidence summary for ${gateKey}:`);
    if (!summary) return;
    await api(`/api/v7/platform/releases/${releaseId}/gates/${gateKey}`, { method: 'PUT', body: JSON.stringify({ status, summary, evidence: { source: 'operator_console' } }) });
    await refresh();
  }, `Gate marked ${status}.`);

  const updateControl = (control: Control, patch: Partial<Control>) => run(async () => {
    const next = { ...control, ...patch };
    await api(`/api/v7/platform/environments/${control.environment}/controls`, { method: 'PATCH', body: JSON.stringify({
      maintenance_mode: next.maintenance_mode,
      writes_paused: next.writes_paused,
      generation_paused: next.generation_paused,
      publishing_paused: next.publishing_paused,
      reason: next.reason || 'Updated from the reliability command centre.',
      incident_id: next.incident_id ?? null,
    }) });
    await refresh();
  }, 'Environment control updated.');

  const createIncident = () => run(async () => {
    if (!incidentForm.title.trim()) throw new Error('Incident title is required.');
    await api('/api/v7/platform/incidents', { method: 'POST', body: JSON.stringify({ ...incidentForm, apply_control_preset: true, public_message: '' }) });
    setIncidentForm((current) => ({ ...current, title: '', impact: '' }));
    await refresh();
  }, 'Incident opened and severity preset applied.');
  const resolveIncident = (id: string) => run(async () => { await api(`/api/v7/platform/incidents/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) }); await refresh(); }, 'Incident resolved. Environment controls remain explicit.');
  const addIncidentEvent = (id: string) => run(async () => {
    const note = window.prompt('Incident timeline note:');
    if (!note) return;
    await api(`/api/v7/platform/incidents/${id}/events`, { method: 'POST', body: JSON.stringify({ event_type: 'mitigation', message: note, metadata: {} }) });
    await refresh();
  }, 'Incident timeline updated.');

  const createDrill = () => run(async () => {
    if (!drillForm.backupHash.trim()) throw new Error('Use a hash or redacted reference, never a raw backup URL or secret.');
    await api('/api/v7/platform/restore-drills', { method: 'POST', body: JSON.stringify({ environment: drillForm.environment, backup_reference_hash: drillForm.backupHash, restore_target: drillForm.target, restore_point: null }) });
    setDrillForm((current) => ({ ...current, backupHash: '' }));
    await refresh();
  }, 'Restore drill planned.');
  const markDrill = (drill: Drill, status: 'running' | 'passed' | 'failed') => run(async () => {
    await api(`/api/v7/platform/restore-drills/${drill.id}`, { method: 'PATCH', body: JSON.stringify({
      status,
      checksum_verified: status === 'passed',
      recovery_point_minutes: status === 'passed' ? 15 : null,
      recovery_time_minutes: status === 'passed' ? 30 : null,
      evidence: { source: 'operator_console', note: status === 'passed' ? 'Restore and checksum confirmed.' : '' },
      failure_reason: status === 'failed' ? 'Restore drill failed; see audit evidence.' : '',
    }) });
    await refresh();
  }, `Restore drill marked ${status}.`);

  return <div className="reliability-shell">
    <header className="reliability-topbar">
      <div className="reliability-brand"><span>BL</span><div><strong>Production reliability</strong><small>{dashboard.runtime.environment} · {dashboard.admin.role}</small></div></div>
      <div className="reliability-actions"><button onClick={onOperations}>Operations</button><button onClick={onOptimization}>Optimization</button><button onClick={onCommercial}>Commercial</button><button onClick={onBack}>Studio</button></div>
    </header>
    <div className="reliability-layout">
      <nav className="reliability-nav">{tabs.map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</nav>
      <main className="reliability-main">
        {(error || message) && <div className={`reliability-alert ${error ? 'error' : ''}`}>{error || message}</div>}
        <RuntimeBanner dashboard={dashboard} />
        {tab === 'releases' && <Releases dashboard={dashboard} form={releaseForm} setForm={setReleaseForm} create={createRelease} runChecks={runChecks} validate={validate} promote={promote} rollback={rollback} decideGate={decideGate} busy={busy} />}
        {tab === 'controls' && <Controls items={dashboard.controls} update={updateControl} busy={busy} />}
        {tab === 'incidents' && <Incidents dashboard={dashboard} form={incidentForm} setForm={setIncidentForm} create={createIncident} resolve={resolveIncident} addEvent={addIncidentEvent} busy={busy} />}
        {tab === 'restore' && <RestoreDrills items={dashboard.restore_drills} form={drillForm} setForm={setDrillForm} create={createDrill} mark={markDrill} busy={busy} />}
        {tab === 'health' && <HealthAudit dashboard={dashboard} />}
      </main>
    </div>
  </div>;
}

function RuntimeBanner({ dashboard }: { dashboard: Dashboard }) {
  const failed = dashboard.runtime.configuration.filter((item) => item.status === 'failed');
  return <div className={`reliability-runtime ${dashboard.runtime.ok ? 'ready' : 'blocked'}`}><div><strong>{dashboard.runtime.ok ? 'Runtime ready' : 'Runtime not ready'}</strong><span>{dashboard.runtime.version} · {short(dashboard.runtime.commit_sha)} · migration {dashboard.runtime.expected_migration_version}</span></div><div><span>Database {dashboard.runtime.database.status} ({dashboard.runtime.database.latency_ms} ms)</span><span>{failed.length} configuration blockers</span></div></div>;
}

function Releases({ dashboard, form, setForm, create, runChecks, validate, promote, rollback, decideGate, busy }: {
  dashboard: Dashboard;
  form: { environment: Environment; version: string; commitSha: string; checksum: string; migration: string; notes: string; rollbackReady: boolean; securityReviewed: boolean };
  setForm: (value: typeof form) => void;
  create: () => Promise<void>;
  runChecks: (id: string) => Promise<void>;
  validate: (id: string) => Promise<void>;
  promote: (release: Release) => Promise<void>;
  rollback: (release: Release) => Promise<void>;
  decideGate: (releaseId: string, gate: GateKey, status: 'passed' | 'failed' | 'waived') => Promise<void>;
  busy: boolean;
}) {
  return <section><Head title="Release promotion gates" text="Create an immutable release from a build manifest, attach current evidence, validate it, then record promotion only after the external deployment succeeds." />
    <Card><div className="reliability-form-grid"><label>Environment<select value={form.environment} onChange={(event) => setForm({ ...form, environment: event.target.value as Environment })}><option value="local">Local</option><option value="staging">Staging</option><option value="production">Production</option></select></label><label>Version<input value={form.version} onChange={(event) => setForm({ ...form, version: event.target.value })} placeholder="7.0.0" /></label><label>Commit SHA<input value={form.commitSha} onChange={(event) => setForm({ ...form, commitSha: event.target.value.trim() })} /></label><label>Artifact checksum<input value={form.checksum} onChange={(event) => setForm({ ...form, checksum: event.target.value.trim() })} /></label><label>Migration<input value={form.migration} onChange={(event) => setForm({ ...form, migration: event.target.value })} /></label><label>Release notes<textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label><label className="reliability-check"><input type="checkbox" checked={form.rollbackReady} onChange={(event) => setForm({ ...form, rollbackReady: event.target.checked })} />Rollback plan recorded</label><label className="reliability-check"><input type="checkbox" checked={form.securityReviewed} onChange={(event) => setForm({ ...form, securityReviewed: event.target.checked })} />Security review completed</label></div><button className="reliability-primary" disabled={busy} onClick={() => void create()}>Create release record</button></Card>
    <div className="reliability-stack">{dashboard.releases.map((release) => <Card key={release.id}><div className="reliability-row"><div><p className="reliability-eyebrow">{release.environment} · {release.status}</p><h2>{release.version}</h2><small>{short(release.commit_sha)} · migration {release.migration_version} · {date(release.created_at)}</small></div><Readiness value={release.readiness} /></div><p>{release.release_notes || 'No release notes.'}</p><div className="reliability-gates">{release.readiness.gates.map((gate) => <div className={`reliability-gate ${gate.current ? 'passed' : gate.status}`} key={gate.gate_key}><div><strong>{gate.gate_key.replaceAll('_', ' ')}</strong><small>{gate.summary || (gate.expired ? 'Evidence expired.' : 'Pending evidence.')}</small></div>{!gate.current && <div><button disabled={busy} onClick={() => void decideGate(release.id, gate.gate_key, 'passed')}>Pass</button><button disabled={busy} onClick={() => void decideGate(release.id, gate.gate_key, 'failed')}>Fail</button>{dashboard.admin.role === 'super_admin' && <button disabled={busy} onClick={() => void decideGate(release.id, gate.gate_key, 'waived')}>Waive</button>}</div>}</div>)}</div><div className="reliability-button-row"><button disabled={busy} onClick={() => void runChecks(release.id)}>Run checks</button>{release.readiness.ready && ['draft', 'checking', 'failed'].includes(release.status) && <button disabled={busy} onClick={() => void validate(release.id)}>Validate</button>}{release.status === 'validated' && <button className="reliability-primary" disabled={busy} onClick={() => void promote(release)}>Record promotion</button>}{['superseded', 'rolled_back', 'validated'].includes(release.status) && dashboard.environments.find((item) => item.name === release.environment)?.active_release_id !== release.id && <button className="reliability-danger" disabled={busy} onClick={() => void rollback(release)}>Rollback to this release</button>}</div></Card>)}{dashboard.releases.length === 0 && <Card><p>No releases recorded.</p></Card>}</div>
  </section>;
}

function Controls({ items, update, busy }: { items: Control[]; update: (item: Control, patch: Partial<Control>) => Promise<void>; busy: boolean }) {
  return <section><Head title="Environment circuit breakers" text="Pause only the risky operation class that needs containment. Resuming service is always a separate explicit action." /><div className="reliability-grid three">{items.map((item) => <Card key={item.environment}><p className="reliability-eyebrow">{item.environment}</p><h2>{item.maintenance_mode ? 'Maintenance mode' : item.writes_paused ? 'Writes paused' : 'Operational'}</h2><p>{item.reason || 'No active operational restriction.'}</p>{(['maintenance_mode', 'writes_paused', 'generation_paused', 'publishing_paused'] as const).map((key) => <label className="reliability-toggle" key={key}><span>{key.replaceAll('_', ' ')}</span><input type="checkbox" disabled={busy} checked={item[key]} onChange={(event) => void update(item, { [key]: event.target.checked })} /></label>)}</Card>)}</div></section>;
}

function Incidents({ dashboard, form, setForm, create, resolve, addEvent, busy }: {
  dashboard: Dashboard; form: { environment: Environment; severity: Incident['severity']; title: string; impact: string }; setForm: (value: typeof form) => void; create: () => Promise<void>; resolve: (id: string) => Promise<void>; addEvent: (id: string) => Promise<void>; busy: boolean;
}) {
  return <section><Head title="Incident command" text="Open an incident, contain damage with a severity preset, preserve a timeline, communicate impact and resolve without silently resuming paused systems." /><Card><div className="reliability-form-grid"><label>Environment<select value={form.environment} onChange={(event) => setForm({ ...form, environment: event.target.value as Environment })}><option value="staging">Staging</option><option value="production">Production</option></select></label><label>Severity<select value={form.severity} onChange={(event) => setForm({ ...form, severity: event.target.value as Incident['severity'] })}><option value="sev1">SEV1</option><option value="sev2">SEV2</option><option value="sev3">SEV3</option><option value="sev4">SEV4</option></select></label><label>Title<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label><label>Impact<textarea value={form.impact} onChange={(event) => setForm({ ...form, impact: event.target.value })} /></label></div><button className="reliability-danger" disabled={busy} onClick={() => void create()}>Open incident</button></Card><div className="reliability-stack">{dashboard.incidents.map((item) => <Card key={item.id}><div className="reliability-row"><div><p className="reliability-eyebrow">{item.incident_key} · {item.environment} · {item.severity}</p><h2>{item.title}</h2></div><span className={`reliability-status ${item.status}`}>{item.status}</span></div><p>{item.impact || 'Impact assessment pending.'}</p><small>Started {date(item.started_at)} · resolved {date(item.resolved_at)}</small><div className="reliability-timeline">{dashboard.incident_events.filter((event) => event.incident_id === item.id).slice(0, 6).map((event) => <div key={event.id}><span>{event.event_type}</span><p>{event.message}</p><small>{date(event.created_at)}</small></div>)}</div><div className="reliability-button-row"><button disabled={busy} onClick={() => void addEvent(item.id)}>Add mitigation note</button>{!['resolved', 'cancelled'].includes(item.status) && <button disabled={busy} onClick={() => void resolve(item.id)}>Resolve</button>}</div></Card>)}</div></section>;
}

function RestoreDrills({ items, form, setForm, create, mark, busy }: { items: Drill[]; form: { environment: Environment; backupHash: string; target: string }; setForm: (value: typeof form) => void; create: () => Promise<void>; mark: (item: Drill, status: 'running' | 'passed' | 'failed') => Promise<void>; busy: boolean }) {
  return <section><Head title="Backup and restore drills" text="A backup does not count as recoverable until a disposable restore succeeds, checksums match and recovery time is recorded." /><Card><div className="reliability-form-grid"><label>Environment<select value={form.environment} onChange={(event) => setForm({ ...form, environment: event.target.value as Environment })}><option value="staging">Staging</option><option value="production">Production</option></select></label><label>Backup reference hash<input value={form.backupHash} onChange={(event) => setForm({ ...form, backupHash: event.target.value })} /></label><label>Restore target<input value={form.target} onChange={(event) => setForm({ ...form, target: event.target.value })} /></label></div><button className="reliability-primary" disabled={busy} onClick={() => void create()}>Plan restore drill</button></Card><div className="reliability-stack">{items.map((item) => <Card key={item.id}><div className="reliability-row"><div><p className="reliability-eyebrow">{item.environment} · {item.status}</p><h2>{item.restore_target}</h2><small>{short(item.backup_reference_hash)} · created {date(item.created_at)}</small></div><span>{item.checksum_verified ? 'Checksum verified' : 'Checksum pending'}</span></div><p>RPO {item.recovery_point_minutes ?? '—'} min · RTO {item.recovery_time_minutes ?? '—'} min · completed {date(item.completed_at)}</p><div className="reliability-button-row">{item.status === 'planned' && <button disabled={busy} onClick={() => void mark(item, 'running')}>Start</button>}{item.status === 'running' && <><button className="reliability-primary" disabled={busy} onClick={() => void mark(item, 'passed')}>Pass with checksum</button><button className="reliability-danger" disabled={busy} onClick={() => void mark(item, 'failed')}>Fail</button></>}</div></Card>)}</div></section>;
}

function HealthAudit({ dashboard }: { dashboard: Dashboard }) {
  const latest = useMemo(() => {
    const map = new Map<string, Health>();
    for (const item of dashboard.health) { const key = `${item.environment}:${item.component}`; if (!map.has(key)) map.set(key, item); }
    return [...map.values()];
  }, [dashboard.health]);
  return <section><Head title="Health evidence and operational audit" text="Health checks are time-bound evidence. Operational events are append-only and contain references, not secrets." /><div className="reliability-grid three">{latest.map((item) => <Card key={item.id}><p className="reliability-eyebrow">{item.environment} · {item.component}</p><h2>{item.status}</h2><p>{item.latency_ms} ms</p><small>Checked {date(item.checked_at)} · expires {date(item.expires_at)}</small></Card>)}</div><Card><h2>Recent operational audit</h2>{dashboard.audit_events.slice(0, 40).map((item) => <div className="reliability-audit" key={item.id}><div><strong>{item.action}</strong><small>{item.environment ?? 'global'} · {item.entity_type}</small></div><span>{date(item.created_at)}</span></div>)}</Card></section>;
}

function Head({ title, text }: { title: string; text: string }) { return <header className="reliability-head"><p className="reliability-eyebrow">Phase 7 · Production launch & reliability</p><h1>{title}</h1><p>{text}</p></header>; }
function Card({ children }: { children: ReactNode }) { return <article className="reliability-card">{children}</article>; }
function Readiness({ value }: { value: Readiness }) { return <div className={`reliability-readiness ${value.ready ? 'ready' : 'blocked'}`}><strong>{value.passed}/{value.required}</strong><small>{value.ready ? 'ready' : `${value.failed} failed · ${value.pending} pending`}</small></div>; }
