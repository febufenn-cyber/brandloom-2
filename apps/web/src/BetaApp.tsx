import { useEffect, useMemo, useState } from 'react';
import { api } from './lib/api';

type Program = { id: string; code: string; name: string; status: string; capacity: number; consent_version: string; created_at: string };
type Participant = { id: string; program_id: string; status: string; cohort_label: string; consent_version: string; created_at: string };
type Invite = { id: string; program_id: string; status: string; intended_role: string; expires_at: string; created_at: string };
type Feedback = { id: string; program_id: string; category: string; severity: string; status: string; title: string; created_at: string };
type QaRun = { id: string; environment: string; suite: string; status: string; cases_total: number; cases_passed: number; cases_failed: number; completed_at?: string | null; expires_at?: string | null };
type Finding = { id: string; finding_key: string; severity: string; status: string; title: string; affected_component: string; created_at: string };
type Assessment = { id: string; environment: string; program_id?: string | null; status: string; summary: Record<string, unknown>; assessed_at: string; expires_at: string };
type Dashboard = { programs: Program[]; participants: Participant[]; invites: Invite[]; feedback: Feedback[]; qa_runs: QaRun[]; findings: Finding[]; assessments: Assessment[] };

const date = (value?: string | null) => value ? new Date(value).toLocaleString() : '—';
const requiredSuites = ['auth', 'rls', 'publishing', 'billing', 'data_rights', 'reliability', 'security'];

export default function BetaApp({ onBack, onActivation, onReliability }: { onBack: () => void; onActivation: () => void; onReliability: () => void }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [programId, setProgramId] = useState('');
  const [environment, setEnvironment] = useState<'staging' | 'production'>('staging');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteUrl, setInviteUrl] = useState('');
  const [programForm, setProgramForm] = useState({ code: '', name: '', capacity: 25, consent_version: 'beta-v1' });
  const [findingForm, setFindingForm] = useState({ severity: 'medium', title: '', affected_component: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    const data = await api<Dashboard>('/api/v9/platform/beta');
    setDashboard(data);
    if (!programId && data.programs[0]) setProgramId(data.programs[0].id);
  };
  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }, []);

  const selected = dashboard?.programs.find((program) => program.id === programId);
  const participants = useMemo(() => dashboard?.participants.filter((item) => item.program_id === programId) ?? [], [dashboard, programId]);
  const invites = useMemo(() => dashboard?.invites.filter((item) => item.program_id === programId) ?? [], [dashboard, programId]);
  const feedback = useMemo(() => dashboard?.feedback.filter((item) => item.program_id === programId) ?? [], [dashboard, programId]);
  const latestAssessment = dashboard?.assessments.find((item) => item.environment === environment && item.program_id === programId);

  const run = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(''); setMessage('');
    try { await work(); setMessage(success); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const createProgram = () => run(async () => {
    const program = await api<Program>('/api/v9/platform/beta/programs', { method: 'POST', body: JSON.stringify(programForm) });
    setProgramId(program.id); setProgramForm({ code: '', name: '', capacity: 25, consent_version: 'beta-v1' });
  }, 'Beta program created.');

  const createInvite = () => run(async () => {
    const result = await api<{ invite_url: string }>('/api/v9/platform/beta/invites', { method: 'POST', body: JSON.stringify({ program_id: programId, email: inviteEmail, intended_role: 'owner', expires_in_hours: 72 }) });
    setInviteUrl(result.invite_url); setInviteEmail('');
  }, 'One-time invitation created. Copy it now; it is not emailed automatically.');

  const createFinding = () => run(async () => {
    await api('/api/v9/platform/security-findings', { method: 'POST', body: JSON.stringify({ ...findingForm, description: '', evidence: {}, remediation: '' }) });
    setFindingForm({ severity: 'medium', title: '', affected_component: '' });
  }, 'Security finding recorded.');

  return <main className="beta-shell">
    <header className="beta-header"><div><p className="beta-kicker">Phase 9 · Security & closed beta</p><h1>Closed Beta Command</h1><p>Manage consent, participants, QA evidence, findings and the launch gate without exposing invite secrets.</p></div><div className="beta-nav"><button onClick={onActivation}>Activation</button><button onClick={onReliability}>Reliability</button><button onClick={onBack}>Workspace</button></div></header>
    {error && <div className="beta-alert error">{error}</div>}{message && <div className="beta-alert success">{message}</div>}

    <section className="beta-topbar"><select value={programId} onChange={(event) => setProgramId(event.target.value)}><option value="">Select beta program</option>{dashboard?.programs.map((program) => <option key={program.id} value={program.id}>{program.name} · {program.status}</option>)}</select><select value={environment} onChange={(event) => setEnvironment(event.target.value as 'staging' | 'production')}><option value="staging">Staging</option><option value="production">Production</option></select></section>

    <section className="beta-metrics"><div><span>Participants</span><strong>{participants.length}/{selected?.capacity ?? 0}</strong></div><div><span>Pending invites</span><strong>{invites.filter((item) => item.status === 'pending').length}</strong></div><div><span>Open feedback</span><strong>{feedback.filter((item) => !['resolved', 'closed', 'duplicate'].includes(item.status)).length}</strong></div><div><span>Gate</span><strong>{latestAssessment?.status ?? 'not assessed'}</strong></div></section>

    <div className="beta-columns">
      <section className="beta-panel"><h2>Create program</h2><input placeholder="program-code" value={programForm.code} onChange={(event) => setProgramForm({ ...programForm, code: event.target.value })}/><input placeholder="Program name" value={programForm.name} onChange={(event) => setProgramForm({ ...programForm, name: event.target.value })}/><div className="beta-row"><input type="number" min={1} value={programForm.capacity} onChange={(event) => setProgramForm({ ...programForm, capacity: Number(event.target.value) })}/><input value={programForm.consent_version} onChange={(event) => setProgramForm({ ...programForm, consent_version: event.target.value })}/></div><button disabled={busy || !programForm.code || !programForm.name} onClick={() => void createProgram()}>Create program</button></section>
      <section className="beta-panel"><h2>One-time invitation</h2><p>Email addresses are hashed in storage. Delivery remains manual.</p><input type="email" placeholder="tester@example.com" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)}/><button disabled={busy || !programId || !inviteEmail} onClick={() => void createInvite()}>Create invite</button>{inviteUrl && <div className="invite-output"><code>{inviteUrl}</code><button onClick={() => void navigator.clipboard.writeText(inviteUrl)}>Copy</button></div>}</section>
    </div>

    <section className="beta-panel"><div className="beta-panel-head"><div><h2>Closed-beta gate</h2><p>Requires active infrastructure, seven current QA suites, no critical/high finding and no SEV1/SEV2 incident.</p></div><button disabled={busy || !programId} onClick={() => void run(() => api('/api/v9/platform/beta/gate', { method: 'POST', body: JSON.stringify({ environment, program_id: programId }) }), 'Beta gate assessed.')}>Assess gate</button></div><div className="qa-grid">{requiredSuites.map((suite) => { const qa = dashboard?.qa_runs.find((item) => item.environment === environment && item.suite === suite); return <article key={suite} className={qa?.status === 'passed' ? 'passed' : ''}><strong>{suite.replaceAll('_', ' ')}</strong><span>{qa?.status ?? 'missing'}</span><small>{date(qa?.completed_at)}</small></article>; })}</div>{latestAssessment && <pre className="beta-summary">{JSON.stringify(latestAssessment.summary, null, 2)}</pre>}</section>

    <div className="beta-columns">
      <section className="beta-panel"><h2>Security finding</h2><select value={findingForm.severity} onChange={(event) => setFindingForm({ ...findingForm, severity: event.target.value })}><option>critical</option><option>high</option><option>medium</option><option>low</option><option>informational</option></select><input placeholder="Finding title" value={findingForm.title} onChange={(event) => setFindingForm({ ...findingForm, title: event.target.value })}/><input placeholder="Affected component" value={findingForm.affected_component} onChange={(event) => setFindingForm({ ...findingForm, affected_component: event.target.value })}/><button disabled={busy || !findingForm.title} onClick={() => void createFinding()}>Record finding</button></section>
      <section className="beta-panel"><h2>Open findings</h2><div className="beta-list">{dashboard?.findings.filter((item) => !['closed', 'false_positive'].includes(item.status)).slice(0, 12).map((item) => <div key={item.id}><strong>{item.finding_key} · {item.severity}</strong><span>{item.title}</span><small>{item.status} · {item.affected_component}</small></div>)}</div></section>
    </div>

    <section className="beta-panel"><h2>Feedback queue</h2><div className="beta-list">{feedback.slice(0, 20).map((item) => <div key={item.id}><strong>{item.severity} · {item.category}</strong><span>{item.title}</span><small>{item.status} · {date(item.created_at)}</small></div>)}</div></section>
  </main>;
}
