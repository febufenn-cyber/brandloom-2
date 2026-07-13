import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './lib/api';

type Brand = { id: string; workspace_id: string; name: string };
type ContentItem = { id: string; title: string; scheduled_date: string; format: string; pillar: string };
type Recommendation = {
  id: string; recommendation_type: string; statement: string; rationale: string; confidence: number;
  attribution_confidence: 'low' | 'medium' | 'high'; sample_size: number; status: string; valid_until?: string | null;
};
type Fatigue = { id: string; signal_type: string; signal_key: string; score: number; recent_count: number; status: string; performance_change: number };
type Opportunity = { id: string; title: string; description: string; signal_type: string; source: string; status: string; opportunity_score: number; valid_until?: string | null };
type Experiment = {
  id: string; name: string; hypothesis: string; status: string; variants: Array<{ key: string; name: string; instructions?: string }>;
  min_sample_size: number; decision: string; decision_reason: string; result?: Record<string, unknown>;
};
type Dashboard = {
  role: string;
  optimization_enabled: boolean;
  latest_review: { id: string; summary: string; window_start: string; window_end: string; created_at: string } | null;
  recommendations: Recommendation[];
  fatigue: Fatigue[];
  opportunities: Opportunity[];
  experiments: Experiment[];
  assignments: Array<{ id: string; experiment_id: string; content_item_id: string; variant_key: string; status: string }>;
  imports: Array<{ id: string; source: string; status: string; rows_accepted: number; rows_rejected: number; created_at: string }>;
  current_performance: {
    summary: string;
    aggregate: { sample_size: number; metrics: Record<string, number>; rates: Record<string, number>; average_score: number };
    top_content: Array<{ content_id: string; score: number; rates: Record<string, number> }>;
  };
};
type Tab = 'overview' | 'recommendations' | 'experiments' | 'opportunities' | 'data';

const percent = (value: number) => `${Math.round(Number(value || 0) * 100)}%`;
const date = (value?: string | null) => value ? new Date(value).toLocaleDateString() : '—';

export default function OptimizationApp({ onBack, onOperations, onPublishing, onCommercial }: {
  onBack: () => void; onOperations: () => void; onPublishing: () => void; onCommercial: () => void;
}) {
  const [brand, setBrand] = useState<Brand | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [content, setContent] = useState<ContentItem[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [importText, setImportText] = useState('');
  const [experimentName, setExperimentName] = useState('Hook framing test');
  const [hypothesis, setHypothesis] = useState('A specific question hook will produce more saves and shares than a broad statement hook.');
  const [assignment, setAssignment] = useState({ experimentId: '', contentId: '', variantKey: 'a' });
  const [opportunity, setOpportunity] = useState({ title: '', description: '', signalType: 'campaign', validUntil: '' });

  const refresh = async () => {
    const boot = await api<{ brand: Brand | null; plans?: Array<{ id: string }> }>('/api/bootstrap');
    setBrand(boot.brand);
    if (!boot.brand) return;
    const [nextDashboard, plans] = await Promise.all([
      api<Dashboard>(`/api/v6/brands/${boot.brand.id}/dashboard`),
      api<{ plans: Array<{ id: string }> }>(`/api/brands/${boot.brand.id}/weekly-plans`),
    ]);
    setDashboard(nextDashboard);
    const latestPlan = plans.plans[0];
    if (latestPlan) {
      const detail = await api<{ items: ContentItem[] }>(`/api/weekly-plans/${latestPlan.id}`);
      setContent(detail.items ?? []);
    } else setContent([]);
  };

  useEffect(() => { void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }, []);

  useEffect(() => {
    if (!content.length || importText) return;
    const now = new Date();
    const start = new Date(now.getTime() - 7 * 86_400_000);
    setImportText(JSON.stringify({
      source: 'manual',
      external_batch_id: `manual-${now.toISOString().slice(0, 10)}`,
      rows: [{
        content_item_id: content[0].id,
        source_event_id: `manual-${content[0].id}-${now.toISOString().slice(0, 10)}`,
        window_start: start.toISOString(), window_end: now.toISOString(), observed_at: now.toISOString(),
        impressions: 0, reach: 0, likes: 0, comments: 0, saves: 0, shares: 0,
        clicks: 0, profile_visits: 0, follows: 0, video_views: 0, watch_time_seconds: 0,
      }],
    }, null, 2));
  }, [content, importText]);

  useEffect(() => {
    const active = dashboard?.experiments.find((item) => item.status === 'active');
    if (!active) return;
    setAssignment((current) => ({
      experimentId: current.experimentId || active.id,
      contentId: current.contentId || content[0]?.id || '',
      variantKey: current.variantKey || active.variants[0]?.key || 'a',
    }));
  }, [dashboard?.experiments, content]);

  const run = async (task: () => Promise<void>, success?: string) => {
    setBusy(true); setError(''); setMessage('');
    try { await task(); if (success) setMessage(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  if (!brand || !dashboard) return <div className="optimization-loading">{error || 'Loading intelligent optimization…'}</div>;
  const tabs: Array<[Tab, string]> = [['overview', 'Performance'], ['recommendations', 'Recommendations'], ['experiments', 'Experiments'], ['opportunities', 'Opportunities'], ['data', 'Metric imports']];

  const generateReview = () => run(async () => {
    await api(`/api/v6/brands/${brand.id}/reviews`, { method: 'POST', body: JSON.stringify({ window_days: 60 }) });
    await refresh();
  }, 'Optimization review generated. Every recommendation still requires a human decision.');

  const decideRecommendation = (id: string, decision: 'approve' | 'reject' | 'pause' | 'reactivate') => run(async () => {
    if (decision === 'approve') await api(`/api/v6/recommendations/${id}/approve`, { method: 'POST', body: JSON.stringify({ note: 'Approved from the optimization command centre.' }) });
    else await api(`/api/v6/recommendations/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision, note: `Decision: ${decision}` }) });
    await refresh();
  }, `Recommendation ${decision}d.`);

  const createExperiment = () => run(async () => {
    await api(`/api/v6/brands/${brand.id}/experiments`, { method: 'POST', body: JSON.stringify({
      name: experimentName,
      hypothesis,
      experiment_type: 'content',
      variants: [
        { key: 'a', name: 'Specific question', instructions: 'Open with one concrete question tied to a customer problem.' },
        { key: 'b', name: 'Broad statement', instructions: 'Open with a broad declarative observation.' },
      ],
      primary_metric: 'engagement_rate', min_sample_size: 5, confidence_threshold: 0.7, attribution_window_days: 7,
    }) });
    await refresh();
  }, 'Experiment created in proposed state.');

  const activateExperiment = (id: string) => run(async () => { await api(`/api/v6/experiments/${id}/activate`, { method: 'POST' }); await refresh(); }, 'Experiment activated.');
  const evaluate = (id: string) => run(async () => { await api(`/api/v6/experiments/${id}/evaluate`, { method: 'POST', body: JSON.stringify({ complete: false }) }); await refresh(); }, 'Experiment evaluated without automatically adopting a winner.');

  const assignContent = () => run(async () => {
    if (!assignment.experimentId || !assignment.contentId) throw new Error('Choose an active experiment and content item.');
    await api(`/api/v6/experiments/${assignment.experimentId}/assignments`, { method: 'POST', body: JSON.stringify({ content_item_id: assignment.contentId, variant_key: assignment.variantKey }) });
    await refresh();
  }, 'Content assigned to the controlled experiment.');

  const addOpportunity = () => run(async () => {
    if (!opportunity.title.trim()) throw new Error('Opportunity title is required.');
    await api(`/api/v6/brands/${brand.id}/opportunities`, { method: 'POST', body: JSON.stringify({
      source: 'manual', signal_type: opportunity.signalType, title: opportunity.title, description: opportunity.description,
      relevance_score: 0.75, confidence: 0.6, valid_until: opportunity.validUntil || null,
    }) });
    setOpportunity({ title: '', description: '', signalType: 'campaign', validUntil: '' });
    await refresh();
  }, 'Opportunity added for review.');

  const importMetrics = () => run(async () => {
    const parsed = JSON.parse(importText) as unknown;
    await api(`/api/v6/brands/${brand.id}/performance/import`, { method: 'POST', body: JSON.stringify(parsed) });
    await refresh();
  }, 'Performance snapshot imported.');

  return <div className="optimization-shell">
    <header className="optimization-topbar">
      <div className="optimization-brand"><span>BL</span><div><strong>{brand.name}</strong><small>Intelligent optimization</small></div></div>
      <div className="optimization-actions"><button onClick={onOperations}>Operations</button><button onClick={onPublishing}>Publishing</button><button onClick={onCommercial}>Commercial</button><button onClick={onBack}>Studio</button></div>
    </header>
    <div className="optimization-layout">
      <nav className="optimization-nav">{tabs.map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</nav>
      <main className="optimization-main">
        {(error || message) && <div className={`optimization-alert ${error ? 'error' : ''}`}>{error || message}</div>}
        {!dashboard.optimization_enabled && <div className="optimization-alert warning">The dashboard remains visible, but generating reviews and controlled experiments requires Growth or Agency in production billing mode.</div>}
        {tab === 'overview' && <Overview dashboard={dashboard} busy={busy} generateReview={generateReview} />}
        {tab === 'recommendations' && <Recommendations items={dashboard.recommendations} busy={busy} decide={decideRecommendation} />}
        {tab === 'experiments' && <Experiments dashboard={dashboard} content={content} busy={busy} createExperiment={createExperiment} activate={activateExperiment} evaluate={evaluate} assign={assignContent} experimentName={experimentName} setExperimentName={setExperimentName} hypothesis={hypothesis} setHypothesis={setHypothesis} assignment={assignment} setAssignment={setAssignment} />}
        {tab === 'opportunities' && <Opportunities items={dashboard.opportunities} opportunity={opportunity} setOpportunity={setOpportunity} addOpportunity={addOpportunity} busy={busy} convert={(item) => run(async () => {
          const start = new Date(); const end = new Date(Date.now() + 14 * 86_400_000);
          await api(`/api/v6/opportunities/${item.id}/convert`, { method: 'POST', body: JSON.stringify({ start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) }) });
          await refresh();
        }, 'Opportunity converted into a draft campaign with normal approval requirements.')} />}
        {tab === 'data' && <MetricImports dashboard={dashboard} content={content} text={importText} setText={setImportText} importMetrics={importMetrics} busy={busy} />}
      </main>
    </div>
  </div>;
}

function Overview({ dashboard, busy, generateReview }: { dashboard: Dashboard; busy: boolean; generateReview: () => Promise<void> }) {
  const aggregate = dashboard.current_performance.aggregate;
  return <section><Head title="Performance intelligence" text="Separate observation from causation, surface uncertainty, and turn approved evidence into temporary strategy." />
    <div className="optimization-grid four"><Metric label="Measured content" value={String(aggregate.sample_size)} /><Metric label="Reach" value={String(aggregate.metrics.reach ?? 0)} /><Metric label="Engagement rate" value={percent(aggregate.rates.engagement_rate ?? 0)} /><Metric label="Open recommendations" value={String(dashboard.recommendations.filter((item) => item.status === 'proposed').length)} /></div>
    <div className="optimization-grid two"><Card><p className="optimization-eyebrow">Latest review</p><h2>{dashboard.latest_review?.summary ?? 'No review generated'}</h2><p>{dashboard.latest_review ? `${date(dashboard.latest_review.window_start)}–${date(dashboard.latest_review.window_end)}` : 'Import consistent metrics, then generate a review.'}</p><button className="optimization-primary" disabled={busy} onClick={() => void generateReview()}>Generate 60-day review</button></Card>
      <Card><p className="optimization-eyebrow">Attribution boundary</p><h2>Correlation is not causation</h2><p>Organic performance can suggest tests. Only adequately powered controlled assignments may create high-attribution recommendations.</p><small>No recommendation changes content or publishing until a reviewer approves it.</small></Card></div>
    <Card><h2>Fatigue watch</h2>{dashboard.fatigue.filter((item) => ['open', 'acknowledged'].includes(item.status)).slice(0, 6).map((item) => <div className="optimization-list-row" key={item.id}><div><strong>{item.signal_type}: {item.signal_key}</strong><small>{item.recent_count} repeated observations · performance change {percent(item.performance_change)}</small></div><span>{percent(item.score)}</span></div>)}{dashboard.fatigue.length === 0 && <p>No active fatigue signals.</p>}</Card>
  </section>;
}

function Recommendations({ items, busy, decide }: { items: Recommendation[]; busy: boolean; decide: (id: string, action: 'approve' | 'reject' | 'pause' | 'reactivate') => Promise<void> }) {
  return <section><Head title="Recommendation inbox" text="Review evidence, confidence, attribution limitations and expiry before anything enters Brand Memory." />
    <div className="optimization-stack">{items.map((item) => <Card key={item.id}><div className="optimization-row"><div><p className="optimization-eyebrow">{item.recommendation_type} · {item.status}</p><h2>{item.statement}</h2></div><Confidence value={item.confidence} attribution={item.attribution_confidence} /></div><p>{item.rationale}</p><div className="optimization-meta"><span>{item.sample_size} observations</span><span>Valid until {date(item.valid_until)}</span></div><div className="optimization-button-row">{item.status === 'proposed' && <><button className="optimization-primary" disabled={busy} onClick={() => void decide(item.id, 'approve')}>Approve temporarily</button><button disabled={busy} onClick={() => void decide(item.id, 'reject')}>Reject</button></>}{['approved', 'active'].includes(item.status) && <button disabled={busy} onClick={() => void decide(item.id, 'pause')}>Pause</button>}{item.status === 'paused' && <button disabled={busy} onClick={() => void decide(item.id, 'reactivate')}>Reactivate</button>}</div></Card>)}{items.length === 0 && <Card><p>No recommendations yet. Import measurements and generate a review.</p></Card>}</div>
  </section>;
}

function Experiments({ dashboard, content, busy, createExperiment, activate, evaluate, assign, experimentName, setExperimentName, hypothesis, setHypothesis, assignment, setAssignment }: {
  dashboard: Dashboard; content: ContentItem[]; busy: boolean; createExperiment: () => Promise<void>; activate: (id: string) => Promise<void>; evaluate: (id: string) => Promise<void>; assign: () => Promise<void>;
  experimentName: string; setExperimentName: (value: string) => void; hypothesis: string; setHypothesis: (value: string) => void;
  assignment: { experimentId: string; contentId: string; variantKey: string }; setAssignment: (value: { experimentId: string; contentId: string; variantKey: string }) => void;
}) {
  const active = dashboard.experiments.filter((item) => item.status === 'active');
  const selected = dashboard.experiments.find((item) => item.id === assignment.experimentId);
  return <section><Head title="Controlled experiments" text="Assign one variant per content item, collect equal outcome windows, and refuse winners when the sample is underpowered." />
    <div className="optimization-grid two"><Card><h2>Create A/B test</h2><label>Name<input value={experimentName} onChange={(event) => setExperimentName(event.target.value)} /></label><label>Hypothesis<textarea value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} /></label><button className="optimization-primary" disabled={busy} onClick={() => void createExperiment()}>Create proposed experiment</button></Card>
      <Card><h2>Assign measured content</h2><label>Active experiment<select value={assignment.experimentId} onChange={(event) => { const experiment = dashboard.experiments.find((item) => item.id === event.target.value); setAssignment({ ...assignment, experimentId: event.target.value, variantKey: experiment?.variants[0]?.key ?? 'a' }); }}><option value="">Choose experiment</option>{active.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Content<select value={assignment.contentId} onChange={(event) => setAssignment({ ...assignment, contentId: event.target.value })}><option value="">Choose content</option>{content.map((item) => <option key={item.id} value={item.id}>{item.title || item.id} · {item.format}</option>)}</select></label><label>Variant<select value={assignment.variantKey} onChange={(event) => setAssignment({ ...assignment, variantKey: event.target.value })}>{(selected?.variants ?? []).map((variant) => <option key={variant.key} value={variant.key}>{variant.name}</option>)}</select></label><button disabled={busy || !active.length} onClick={() => void assign()}>Assign variant</button></Card></div>
    <div className="optimization-stack">{dashboard.experiments.map((item) => <Card key={item.id}><div className="optimization-row"><div><p className="optimization-eyebrow">{item.status} · {item.decision}</p><h2>{item.name}</h2></div><span>{item.min_sample_size} per variant</span></div><p>{item.hypothesis}</p><div className="optimization-variants">{item.variants.map((variant) => <span key={variant.key}>{variant.key}: {variant.name}</span>)}</div><p>{item.decision_reason}</p><div className="optimization-button-row">{item.status === 'proposed' && <button className="optimization-primary" disabled={busy} onClick={() => void activate(item.id)}>Activate</button>}{item.status === 'active' && <button disabled={busy} onClick={() => void evaluate(item.id)}>Evaluate safely</button>}</div></Card>)}</div>
  </section>;
}

function Opportunities({ items, opportunity, setOpportunity, addOpportunity, convert, busy }: {
  items: Opportunity[]; opportunity: { title: string; description: string; signalType: string; validUntil: string };
  setOpportunity: (value: { title: string; description: string; signalType: string; validUntil: string }) => void;
  addOpportunity: () => Promise<void>; convert: (item: Opportunity) => Promise<void>; busy: boolean;
}) {
  return <section><Head title="Opportunity signals" text="Capture events and customer signals with relevance, confidence and expiry. Conversion creates a draft campaign, never an automatic launch." />
    <Card><div className="optimization-grid two"><label>Title<input value={opportunity.title} onChange={(event) => setOpportunity({ ...opportunity, title: event.target.value })} /></label><label>Type<select value={opportunity.signalType} onChange={(event) => setOpportunity({ ...opportunity, signalType: event.target.value })}><option value="campaign">Campaign</option><option value="event">Event</option><option value="trend">Trend</option><option value="product">Product</option><option value="audience">Audience</option><option value="retention">Retention</option></select></label><label>Description<textarea value={opportunity.description} onChange={(event) => setOpportunity({ ...opportunity, description: event.target.value })} /></label><label>Valid until<input type="date" value={opportunity.validUntil} onChange={(event) => setOpportunity({ ...opportunity, validUntil: event.target.value })} /></label></div><button className="optimization-primary" disabled={busy} onClick={() => void addOpportunity()}>Add opportunity</button></Card>
    <div className="optimization-stack">{items.map((item) => <Card key={item.id}><div className="optimization-row"><div><p className="optimization-eyebrow">{item.source} · {item.signal_type} · {item.status}</p><h2>{item.title}</h2></div><span>{percent(item.opportunity_score)}</span></div><p>{item.description}</p><div className="optimization-meta"><span>Expires {date(item.valid_until)}</span></div>{['new', 'accepted'].includes(item.status) && <button disabled={busy} onClick={() => void convert(item)}>Convert to draft campaign</button>}</Card>)}</div>
  </section>;
}

function MetricImports({ dashboard, content, text, setText, importMetrics, busy }: { dashboard: Dashboard; content: ContentItem[]; text: string; setText: (value: string) => void; importMetrics: () => Promise<void>; busy: boolean }) {
  return <section><Head title="Performance data" text="Import cumulative snapshots with stable source event IDs. Existing observations are append-only and duplicate events are rejected." />
    <div className="optimization-grid two"><Card><h2>JSON import</h2><textarea className="optimization-json" value={text} onChange={(event) => setText(event.target.value)} /><button className="optimization-primary" disabled={busy || !content.length} onClick={() => void importMetrics()}>Import snapshot</button><small>{content.length ? `${content.length} content items are available in the latest weekly plan.` : 'Create a weekly plan before importing content performance.'}</small></Card>
      <Card><h2>Import history</h2>{dashboard.imports.map((item) => <div className="optimization-list-row" key={item.id}><div><strong>{item.source} · {item.status}</strong><small>{date(item.created_at)}</small></div><span>{item.rows_accepted}/{item.rows_accepted + item.rows_rejected}</span></div>)}{dashboard.imports.length === 0 && <p>No metric imports yet.</p>}</Card></div>
  </section>;
}

function Head({ title, text }: { title: string; text: string }) { return <header className="optimization-head"><p className="optimization-eyebrow">Phase 6 · Intelligent optimization</p><h1>{title}</h1><p>{text}</p></header>; }
function Card({ children }: { children: ReactNode }) { return <article className="optimization-card">{children}</article>; }
function Metric({ label, value }: { label: string; value: string }) { return <article className="optimization-metric"><small>{label}</small><strong>{value}</strong></article>; }
function Confidence({ value, attribution }: { value: number; attribution: string }) { return <div className={`optimization-confidence ${attribution}`}><strong>{percent(value)}</strong><small>{attribution} attribution</small></div>; }
