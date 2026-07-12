import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from './lib/api';

type Brand = { id: string; workspace_id: string; name: string };
type Connection = {
  id: string;
  status: string;
  granted_scopes: string[];
  last_validated_at?: string | null;
  created_at: string;
};
type PlatformAccount = {
  id: string;
  connection_id: string;
  username: string;
  display_name: string;
  account_type: string;
  status: string;
  capabilities: Record<string, unknown>;
  profile_image_url: string;
};
type Account = {
  brand_id: string;
  platform_account_id: string;
  is_default: boolean;
  publishing_enabled: boolean;
  platform_accounts?: PlatformAccount | null;
};
type Job = {
  id: string;
  status: string;
  scheduled_for: string;
  brand_timezone: string;
  local_scheduled_time: string;
  safe_error_message: string;
  attempt_count: number;
  publication_snapshots?: {
    snapshot?: {
      content?: { id: string; title: string; format: string; caption: string };
      destination?: { username: string };
    };
  } | null;
  remote_publications?: Array<{ permalink: string; verified_at: string }> | null;
};
type PublishingData = {
  workspace_id: string;
  connections: Connection[];
  accounts: Account[];
  jobs: Job[];
  controls: Array<{
    id: string;
    publishing_paused: boolean;
    pause_reason: string;
    brand_id?: string | null;
    platform_account_id?: string | null;
  }>;
};
type Content = {
  id: string;
  title: string;
  workflow_status: string;
  scheduled_date: string;
  format: string;
  caption?: string;
  campaign_id?: string | null;
};
type OpsData = { content: Content[] };
type JobDetail = {
  job: Job;
  snapshot: {
    snapshot: Record<string, any>;
    snapshot_checksum: string;
    approval_snapshot: any[];
    preflight_snapshot: any;
  };
  attempts: Array<Record<string, any>>;
  remote?: Record<string, any> | null;
  events: Array<Record<string, any>>;
};
type Tab = 'command' | 'connections' | 'schedule' | 'jobs' | 'safety';
type Runner = (task: () => Promise<void>, success?: string) => Promise<void>;

type PreflightResult = {
  eligible: boolean;
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
};

function localInput(date = new Date(Date.now() + 10 * 60_000)) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function apiOrigin() {
  const configured = (import.meta.env.VITE_API_URL as string | undefined) ?? window.location.origin;
  return new URL(configured, window.location.origin).origin;
}

export default function PublishingApp({ onBack, onOperations }: { onBack: () => void; onOperations: () => void }) {
  const [brand, setBrand] = useState<Brand | null>(null);
  const [data, setData] = useState<PublishingData | null>(null);
  const [ops, setOps] = useState<OpsData | null>(null);
  const [tab, setTab] = useState<Tab>('command');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [jobDetail, setJobDetail] = useState<JobDetail | null>(null);

  const refresh = async () => {
    const boot = await api<{ brand: Brand | null }>('/api/bootstrap');
    setBrand(boot.brand);
    if (boot.brand) {
      const [publishing, operations] = await Promise.all([
        api<PublishingData>(`/api/v4/brands/${boot.brand.id}/publishing-dashboard`),
        api<OpsData>(`/api/v3/brands/${boot.brand.id}/operations`),
      ]);
      setData(publishing);
      setOps(operations);
    }
  };

  useEffect(() => {
    void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    const connected = (event: MessageEvent) => {
      if (event.origin === apiOrigin() && event.data?.type === 'brandloom-meta-connection') {
        setMessage(event.data.message ?? 'Connection updated.');
        void refresh();
      }
    };
    window.addEventListener('message', connected);
    return () => window.removeEventListener('message', connected);
  }, []);

  const run: Runner = async (task, success) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await task();
      if (success) setMessage(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const openJob = (id: string) => run(async () => {
    setJobDetail(await api<JobDetail>(`/api/v4/publication-jobs/${id}`));
  });

  if (!brand || !data || !ops) return <div className="center-shell">{error || 'Loading publishing…'}</div>;

  const tabs: Array<[Tab, string]> = [
    ['command', 'Command centre'],
    ['connections', 'Connections'],
    ['schedule', 'Schedule'],
    ['jobs', 'Delivery history'],
    ['safety', 'Safety'],
  ];

  return <div className="publish-shell">
    <header className="publish-top">
      <div className="publish-brand"><span>BL</span><div><strong>{brand.name}</strong><small>Trusted publishing</small></div></div>
      <div className="publish-top-actions"><button onClick={onOperations}>Operations</button><button onClick={onBack}>Studio</button></div>
    </header>
    <div className="publish-layout">
      <nav className="publish-nav">
        {tabs.map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}
      </nav>
      <main className="publish-main">
        {(error || message) && <div className={`publish-alert ${error ? 'error' : ''}`}>{error || message}</div>}
        {tab === 'command' && <CommandCentre data={data} ops={ops} openJob={openJob} />}
        {tab === 'connections' && <Connections brand={brand} data={data} run={run} busy={busy} refresh={refresh} />}
        {tab === 'schedule' && <Scheduler data={data} ops={ops} run={run} busy={busy} refresh={refresh} openJob={openJob} />}
        {tab === 'jobs' && <Jobs data={data} openJob={openJob} />}
        {tab === 'safety' && <Safety brand={brand} data={data} run={run} busy={busy} refresh={refresh} />}
      </main>
    </div>
    {jobDetail && <JobDrawer
      detail={jobDetail}
      run={run}
      busy={busy}
      refresh={async () => {
        await refresh();
        setJobDetail(await api<JobDetail>(`/api/v4/publication-jobs/${jobDetail.job.id}`));
      }}
      close={() => setJobDetail(null)}
    />}
  </div>;
}

function CommandCentre({ data, ops, openJob }: { data: PublishingData; ops: OpsData; openJob: (id: string) => Promise<void> }) {
  const scheduled = data.jobs.filter((job) => ['scheduled', 'ready', 'retry_waiting'].includes(job.status));
  const active = data.jobs.filter((job) => ['dispatching', 'remote_media_created', 'remote_processing', 'publish_requested', 'published'].includes(job.status));
  const attention = data.jobs.filter((job) => ['preflight_failed', 'permission_failure', 'asset_failure', 'remote_rejection', 'verification_uncertain', 'manual_action_required'].includes(job.status));
  const verified = data.jobs.filter((job) => ['verified', 'completed'].includes(job.status));
  return <section>
    <Head title="Publishing command centre" text="Every job exposes its exact destination, frozen content version and current delivery state." />
    <div className="publish-grid four">
      <Metric value={scheduled.length} label="Scheduled" />
      <Metric value={active.length} label="Publishing now" />
      <Metric value={attention.length} label="Needs attention" danger={attention.length > 0} />
      <Metric value={verified.length} label="Verified" />
    </div>
    <div className="publish-grid two">
      <div className="publish-card"><h2>Next deliveries</h2><JobList jobs={[...active, ...scheduled].slice(0, 8)} openJob={openJob} /></div>
      <div className="publish-card">
        <h2>Readiness gap</h2>
        <p>{ops.content.filter((item) => item.workflow_status === 'ready_to_publish').length} content items are ready to schedule.</p>
        <p>{ops.content.filter((item) => item.workflow_status === 'approved').length} are approved but may still need publishing readiness checks.</p>
        {data.accounts.length === 0 && <div className="publish-warning">Connect and confirm a destination account before scheduling.</div>}
      </div>
    </div>
    {attention.length > 0 && <div className="publish-card"><h2>Manual attention</h2><JobList jobs={attention} openJob={openJob} /></div>}
  </section>;
}

function Connections({ brand, data, run, busy, refresh }: { brand: Brand; data: PublishingData; run: Runner; busy: boolean; refresh: () => Promise<void> }) {
  const connect = () => run(async () => {
    const result = await api<{ authorizationUrl: string }>(`/api/v4/brands/${brand.id}/integrations/meta/connect`, { method: 'POST', body: '{}' });
    const popup = window.open(result.authorizationUrl, 'brandloom-meta', 'width=640,height=760');
    if (!popup) window.location.href = result.authorizationUrl;
  });

  return <section>
    <Head title="Connections" text="Account identity must be confirmed before publishing is enabled." />
    <button className="publish-primary" disabled={busy} onClick={() => void connect()}>Connect Instagram</button>
    <div className="publish-grid cards">
      {data.accounts.map((mapping) => {
        const account = mapping.platform_accounts;
        if (!account) return null;
        const connection = data.connections.find((item) => item.id === account.connection_id);
        return <article className="publish-card" key={account.id}>
          <div className="publish-row">
            <div><p className="publish-eyebrow">Instagram destination</p><h2>@{account.username || account.id}</h2><p>{account.display_name} · {account.account_type || 'Account type unconfirmed'}</p></div>
            <span className={`publish-status ${mapping.publishing_enabled ? 'good' : ''}`}>{mapping.publishing_enabled ? 'Enabled' : 'Confirmation required'}</span>
          </div>
          <p>Connection: {connection?.status ?? 'unknown'}</p>
          <div className="publish-capabilities">
            {Object.entries(account.capabilities ?? {}).map(([key, value]) => <span key={key}>{key.replaceAll('_', ' ')}: {String(value)}</span>)}
          </div>
          <div className="publish-actions">
            {!mapping.publishing_enabled && <button className="publish-primary" disabled={busy} onClick={() => void run(async () => {
              await api(`/api/v4/brands/${brand.id}/platform-accounts/${account.id}/activate`, { method: 'POST', body: JSON.stringify({ is_default: true, publishing_enabled: true }) });
              await refresh();
            }, 'Destination confirmed.')}>Confirm destination</button>}
            <button disabled={busy} onClick={() => void run(async () => {
              await api(`/api/v4/connections/${account.connection_id}/revalidate`, { method: 'POST' });
              await refresh();
            }, 'Connection revalidated.')}>Revalidate</button>
            <button className="danger" disabled={busy} onClick={() => void run(async () => {
              await api(`/api/v4/connections/${account.connection_id}/disconnect`, { method: 'POST' });
              await refresh();
            }, 'Connection disconnected.')}>Disconnect</button>
          </div>
        </article>;
      })}
    </div>
    {data.accounts.length === 0 && <div className="publish-empty">No destination accounts connected.</div>}
  </section>;
}

function Scheduler({ data, ops, run, busy, refresh, openJob }: { data: PublishingData; ops: OpsData; run: Runner; busy: boolean; refresh: () => Promise<void>; openJob: (id: string) => Promise<void> }) {
  const ready = ops.content.filter((item) => ['approved', 'ready_to_publish'].includes(item.workflow_status));
  const accounts = data.accounts.filter((item) => item.publishing_enabled && item.platform_accounts);
  const [contentId, setContentId] = useState(ready[0]?.id ?? '');
  const [accountId, setAccountId] = useState(accounts[0]?.platform_account_id ?? '');
  const [date, setDate] = useState(localInput());
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const selected = ready.find((item) => item.id === contentId);
  const selectedAccount = accounts.find((item) => item.platform_account_id === accountId)?.platform_accounts;
  const iso = () => new Date(date).toISOString();

  const check = () => run(async () => {
    setPreflight(await api<PreflightResult>(`/api/v4/content-items/${contentId}/publication/preflight`, {
      method: 'POST',
      body: JSON.stringify({ platform_account_id: accountId, scheduled_for: iso() }),
    }));
  });

  const schedule = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const job = await api<Job>(`/api/v4/content-items/${contentId}/publications`, {
        method: 'POST',
        body: JSON.stringify({ platform_account_id: accountId, scheduled_for: iso(), brand_timezone: timezone, local_scheduled_time: date }),
      });
      await refresh();
      await openJob(job.id);
    }, 'Publication scheduled.');
  };

  const publishNow = () => run(async () => {
    const result = await api<{ job: Job }>(`/api/v4/content-items/${contentId}/publications/publish-now`, {
      method: 'POST',
      body: JSON.stringify({ platform_account_id: accountId, brand_timezone: timezone }),
    });
    await refresh();
    await openJob(result.job.id);
  }, 'Publication dispatch started.');

  return <section>
    <Head title="Schedule approved content" text="Scheduling freezes the exact version, destination, approvals and media order." />
    <form className="publish-card publish-schedule" onSubmit={schedule}>
      <div className="publish-grid two">
        <Field label="Approved content"><select value={contentId} onChange={(event) => { setContentId(event.target.value); setPreflight(null); }}><option value="">Choose content…</option>{ready.map((item) => <option value={item.id} key={item.id}>{item.scheduled_date} · {item.title} · {item.format}</option>)}</select></Field>
        <Field label="Destination"><select value={accountId} onChange={(event) => { setAccountId(event.target.value); setPreflight(null); }}><option value="">Choose account…</option>{accounts.map((item) => <option value={item.platform_account_id} key={item.platform_account_id}>@{item.platform_accounts?.username}</option>)}</select></Field>
      </div>
      <Field label={`Publish time · ${timezone}`}><input type="datetime-local" value={date} onChange={(event) => { setDate(event.target.value); setPreflight(null); }} /></Field>
      {selected && <div className="publish-preview">
        <p className="publish-eyebrow">Frozen preview</p>
        <div className="publish-row"><div><h2>{selected.title}</h2><p>{selected.format} · {selected.workflow_status}</p></div><strong>@{selectedAccount?.username ?? 'destination'}</strong></div>
        <p>{selected.caption}</p>
      </div>}
      {preflight && <Preflight result={preflight} />}
      <div className="publish-actions">
        <button type="button" disabled={busy || !contentId || !accountId} onClick={() => void check()}>Run preflight</button>
        <button className="publish-primary" disabled={busy || !contentId || !accountId}>Schedule frozen version</button>
        <button type="button" className="publish-primary dark" disabled={busy || !contentId || !accountId} onClick={() => void publishNow()}>Publish now</button>
      </div>
    </form>
    {ready.length === 0 && <div className="publish-empty">No content is approved and ready. Complete it in Operations first.</div>}
  </section>;
}

function Jobs({ data, openJob }: { data: PublishingData; openJob: (id: string) => Promise<void> }) {
  return <section><Head title="Delivery history" text="Published means accepted remotely; verified means Brandloom reconciled the final media object." /><div className="publish-card"><JobList jobs={data.jobs} openJob={openJob} /></div></section>;
}

function Safety({ brand, data, run, busy, refresh }: { brand: Brand; data: PublishingData; run: Runner; busy: boolean; refresh: () => Promise<void> }) {
  const activePause = data.controls.find((item) => item.publishing_paused && !item.brand_id && !item.platform_account_id);
  const pause = () => run(async () => {
    await api(`/api/v4/workspaces/${data.workspace_id}/publishing/pause`, { method: 'POST', body: JSON.stringify({ reason: 'Paused manually from the Brandloom safety centre.' }) });
    await refresh();
  }, 'Publishing paused.');
  const resume = () => activePause && run(async () => {
    await api(`/api/v4/publishing-controls/${activePause.id}/resume`, { method: 'POST' });
    await refresh();
  }, 'Publishing resumed.');

  return <section>
    <Head title="Safety centre" text="Use the kill switch when account identity, approvals or platform behaviour is uncertain." />
    <div className={`publish-card safety-card ${activePause ? 'paused' : ''}`}>
      <p className="publish-eyebrow">Workspace publishing</p>
      <h2>{activePause ? 'Paused' : 'Active'}</h2>
      <p>{activePause?.pause_reason ?? `Automatic dispatch is allowed for confirmed accounts linked to ${brand.name}.`}</p>
      {activePause
        ? <button className="publish-primary" disabled={busy} onClick={() => void resume()}>Resume publishing</button>
        : <button className="danger-button" disabled={busy} onClick={() => void pause()}>Emergency pause</button>}
    </div>
    <div className="publish-grid two">
      <div className="publish-card"><h2>Guardrails</h2><ul><li>Only immutable approved versions can be scheduled.</li><li>Expired offers and asset rights block dispatch.</li><li>Unknown remote results require reconciliation before retry.</li><li>Disconnecting removes credential material.</li></ul></div>
      <div className="publish-card"><h2>Manual fallback</h2><p>Failed jobs retain the Phase 3 export package. Marking a post as manually published remains distinct from API verification.</p></div>
    </div>
  </section>;
}

function JobDrawer({ detail, run, busy, refresh, close }: { detail: JobDetail; run: Runner; busy: boolean; refresh: () => Promise<void>; close: () => void }) {
  const job = detail.job;
  const snapshot = detail.snapshot.snapshot;
  const act = (path: string, success: string, body = '{}') => run(async () => {
    await api(`/api/v4/publication-jobs/${job.id}/${path}`, { method: 'POST', body });
    await refresh();
  }, success);

  return <div className="publish-overlay" onMouseDown={close}><aside className="publish-drawer" onMouseDown={(event) => event.stopPropagation()}>
    <div className="publish-row"><div><p className="publish-eyebrow">Publication job</p><h2>{snapshot.content?.title}</h2></div><button onClick={close}>Close</button></div>
    <span className={`publish-status ${['verified', 'completed'].includes(job.status) ? 'good' : ''}`}>{job.status}</span>
    <p>Destination: @{snapshot.destination?.username}</p>
    <p>Scheduled: {new Date(job.scheduled_for).toLocaleString()} · {job.brand_timezone}</p>
    {job.safe_error_message && <div className="publish-alert error">{job.safe_error_message}</div>}
    <div className="publish-card inset"><h3>Frozen version</h3><p>{snapshot.content?.caption}</p><small>Revision {snapshot.content?.material_revision} · checksum {detail.snapshot.snapshot_checksum}</small></div>
    <div className="publish-grid two">
      <div><h3>Attempts</h3>{detail.attempts.map((attempt) => <div className="publish-event" key={attempt.id}><strong>#{attempt.attempt_number} · {attempt.provider_stage}</strong><small>{attempt.safe_error_message || attempt.completed_at || attempt.started_at}</small></div>)}</div>
      <div><h3>State history</h3>{detail.events.map((event) => <div className="publish-event" key={event.id}><strong>{event.previous_status ?? 'created'} → {event.next_status}</strong><small>{new Date(event.created_at).toLocaleString()}</small></div>)}</div>
    </div>
    {detail.remote?.permalink && <a className="publish-primary link" href={detail.remote.permalink} target="_blank" rel="noreferrer">Open verified publication</a>}
    <div className="publish-actions sticky">
      <button disabled={busy} onClick={() => void act('reconcile', 'Reconciliation complete.')}>Reconcile</button>
      <button disabled={busy || job.status === 'verification_uncertain'} onClick={() => void act('retry', 'Retry attempted.')}>Retry safely</button>
      <button disabled={busy} onClick={() => void act('mark-manual', 'Marked as manually published.', JSON.stringify({ note: 'Published manually after operator verification.', remote_url: '' }))}>Mark manual</button>
      <button className="danger" disabled={busy} onClick={() => void act('cancel', 'Publication cancelled.')}>Cancel</button>
    </div>
  </aside></div>;
}

function JobList({ jobs, openJob }: { jobs: Job[]; openJob: (id: string) => Promise<void> }) {
  return <div className="publish-list">{jobs.map((job) => <button className="publish-list-item" key={job.id} onClick={() => void openJob(job.id)}>
    <div><strong>{job.publication_snapshots?.snapshot?.content?.title ?? 'Publication'}</strong><small>@{job.publication_snapshots?.snapshot?.destination?.username ?? 'destination'} · {new Date(job.scheduled_for).toLocaleString()}</small></div>
    <span className={`publish-status ${['verified', 'completed'].includes(job.status) ? 'good' : ['manual_action_required', 'verification_uncertain', 'preflight_failed'].includes(job.status) ? 'risk' : ''}`}>{job.status}</span>
  </button>)}{jobs.length === 0 && <p>No publication jobs.</p>}</div>;
}

function Preflight({ result }: { result: PreflightResult }) {
  return <div className={`preflight ${result.eligible ? 'pass' : 'fail'}`}>
    <h3>{result.eligible ? 'Preflight passed' : 'Preflight blocked'}</h3>
    {result.errors.map((issue) => <p key={issue.code}>✕ {issue.message}</p>)}
    {result.warnings.map((issue) => <p key={issue.code}>△ {issue.message}</p>)}
  </div>;
}

function Head({ title, text }: { title: string; text: string }) {
  return <header className="publish-head"><p className="publish-eyebrow">Phase 4 · Delivery certainty</p><h1>{title}</h1><p>{text}</p></header>;
}

function Metric({ value, label, danger = false }: { value: number; label: string; danger?: boolean }) {
  return <div className={`publish-card metric ${danger ? 'danger-metric' : ''}`}><strong>{value}</strong><span>{label}</span></div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="publish-field"><span>{label}</span>{children}</label>;
}
