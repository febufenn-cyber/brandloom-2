import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from './lib/api';
import { supabase } from './lib/supabase';
import './phase2.css';

type Plan = { id: string; week_start: string; primary_goal: string; status: string };
type MemoryEvidence = { id: string; source_type: string; before_text: string; after_text: string; weight: number; created_at: string };
type MemoryItem = {
  id: string;
  memory_type: string;
  statement: string;
  scope: Record<string, unknown>;
  durability: string;
  confidence: number;
  status: string;
  origin: string;
  evidence_count: number;
  valid_until?: string | null;
  memory_evidence?: MemoryEvidence[];
};
type RepetitionWarning = { type: string; message: string; count: number; evidence: string };
type LearningReview = {
  summary: string;
  observations: Array<{ signal: string; evidence: string; importance: string }>;
  retire_suggestions: Array<{ statement: string; reason: string }>;
  experiment_suggestions: Array<{ hypothesis: string; variants: string[]; success_metric: string }>;
};
type Bootstrap = { brand: { id: string; name: string } | null; plans?: Plan[] };

const MEMORY_TYPES = [
  'voice_preference', 'selling_style', 'factual_rule', 'compliance_restriction',
  'product_lesson', 'audience_lesson', 'campaign_lesson', 'temporary_context',
  'strategic_suggestion',
];

export default function MemoryDock() {
  const [open, setOpen] = useState(false);
  const [brand, setBrand] = useState<Bootstrap['brand']>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [inbox, setInbox] = useState<MemoryItem[]>([]);
  const [warnings, setWarnings] = useState<RepetitionWarning[]>([]);
  const [review, setReview] = useState<LearningReview | null>(null);
  const [selectedPlan, setSelectedPlan] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState({ memory_type: 'voice_preference', statement: '', durability: 'stable', valid_until: '' });

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) { setBrand(null); return; }
      const bootstrap = await api<Bootstrap>('/api/bootstrap');
      setBrand(bootstrap.brand);
      setPlans(bootstrap.plans ?? []);
      setSelectedPlan((current) => current || bootstrap.plans?.[0]?.id || '');
    };
    void load().catch(() => setBrand(null));
    const subscription = supabase.auth.onAuthStateChange(() => { void load(); });
    return () => subscription.data.subscription.unsubscribe();
  }, []);

  const refresh = async () => {
    if (!brand) return;
    const [all, learning, repetition] = await Promise.all([
      api<{ memories: MemoryItem[] }>(`/api/v2/brands/${brand.id}/memories`),
      api<{ memories: MemoryItem[] }>(`/api/v2/brands/${brand.id}/learning-inbox`),
      api<{ warnings: RepetitionWarning[] }>(`/api/v2/brands/${brand.id}/repetition-report`),
    ]);
    setMemories(all.memories);
    setInbox(learning.memories);
    setWarnings(repetition.warnings);
  };

  useEffect(() => { if (open && brand) void refresh().catch((reason) => setError(String(reason))); }, [open, brand?.id]);

  const run = async (task: () => Promise<void>, success: string) => {
    setBusy(true); setError(''); setMessage('');
    try { await task(); setMessage(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const teach = (event: FormEvent) => {
    event.preventDefault();
    if (!brand) return;
    void run(async () => {
      await api(`/api/v2/brands/${brand.id}/memories`, {
        method: 'POST',
        body: JSON.stringify({
          memory_type: form.memory_type,
          statement: form.statement,
          durability: form.durability,
          structured_value: {},
          scope: {},
          valid_until: form.valid_until || null,
        }),
      });
      setForm({ ...form, statement: '', valid_until: '' });
      await refresh();
    }, 'Brand rule saved as confirmed memory.');
  };

  const decide = (memoryId: string, action: 'confirm' | 'reject' | 'pause' | 'reactivate') => {
    void run(async () => {
      await api(`/api/v2/memories/${memoryId}/${action}`, { method: 'POST', body: JSON.stringify({ note: '' }) });
      await refresh();
    }, `Memory ${action === 'confirm' ? 'confirmed' : action === 'reject' ? 'rejected' : action === 'pause' ? 'paused' : 'reactivated'}.`);
  };

  const createReview = () => {
    if (!selectedPlan) return;
    void run(async () => {
      const result = await api<LearningReview>(`/api/v2/weekly-plans/${selectedPlan}/learning-review`, { method: 'POST' });
      setReview(result);
      await refresh();
    }, 'Weekly learning review created.');
  };

  const exportMemory = () => {
    if (!brand) return;
    void run(async () => {
      const result = await api<Record<string, unknown>>(`/api/v2/brands/${brand.id}/memory/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${brand.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-brand-memory.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    }, 'Memory export prepared.');
  };

  const active = useMemo(() => memories.filter((memory) => ['confirmed', 'active', 'paused'].includes(memory.status)), [memories]);
  if (!brand) return null;

  return <>
    <button className="memory-launcher" onClick={() => setOpen(true)} aria-label="Open brand memory">
      <span>◈</span><strong>Memory</strong>{inbox.length > 0 && <em>{inbox.length}</em>}
    </button>
    {open && <div className="memory-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section className="memory-dock" aria-label="Brand memory centre">
        <header className="memory-header">
          <div><p className="memory-eyebrow">Phase 2</p><h2>What Brandloom learned</h2><p>{brand.name} retains evidence, not hidden guesses.</p></div>
          <button className="memory-close" onClick={() => setOpen(false)}>×</button>
        </header>
        {(error || message) && <div className={`memory-alert ${error ? 'error' : 'success'}`}>{error || message}</div>}

        <div className="memory-summary">
          <article><strong>{active.filter((item) => item.status !== 'paused').length}</strong><span>active rules</span></article>
          <article><strong>{inbox.length}</strong><span>need review</span></article>
          <article><strong>{warnings.length}</strong><span>repetition risks</span></article>
        </div>

        <details open className="memory-section">
          <summary>Learning inbox <span>{inbox.length}</span></summary>
          {inbox.length === 0 ? <p className="memory-empty">No inferred lessons are waiting. One edit never becomes a permanent rule automatically.</p> :
            <div className="memory-list">{inbox.map((memory) => <article className="memory-card candidate" key={memory.id}>
              <div className="memory-card-head"><span>{memory.memory_type.replaceAll('_', ' ')}</span><strong>{Math.round(memory.confidence * 100)}%</strong></div>
              <p>{memory.statement}</p>
              <small>{memory.evidence_count} evidence item{memory.evidence_count === 1 ? '' : 's'} · {memory.durability}</small>
              {memory.memory_evidence?.[0] && <details className="memory-evidence"><summary>Why Brandloom inferred this</summary><p>{memory.memory_evidence[0].source_type.replaceAll('_', ' ')}</p></details>}
              <div className="memory-actions"><button disabled={busy} onClick={() => decide(memory.id, 'confirm')}>Confirm</button><button disabled={busy} onClick={() => decide(memory.id, 'reject')}>Reject</button></div>
            </article>)}</div>}
        </details>

        <details open className="memory-section">
          <summary>Active brand memory <span>{active.length}</span></summary>
          <div className="memory-list">{active.map((memory) => <article className={`memory-card ${memory.status}`} key={memory.id}>
            <div className="memory-card-head"><span>{memory.memory_type.replaceAll('_', ' ')}</span><strong>{memory.status}</strong></div>
            <p>{memory.statement}</p>
            <small>{memory.origin} · {memory.durability}{memory.valid_until ? ` · expires ${memory.valid_until}` : ''}</small>
            <div className="memory-actions">{memory.status === 'paused'
              ? <button disabled={busy} onClick={() => decide(memory.id, 'reactivate')}>Reactivate</button>
              : <button disabled={busy} onClick={() => decide(memory.id, 'pause')}>Pause</button>}</div>
          </article>)}</div>
        </details>

        <details className="memory-section">
          <summary>Teach Brandloom directly</summary>
          <form className="teach-form" onSubmit={teach}>
            <label><span>Rule type</span><select value={form.memory_type} onChange={(event) => setForm({ ...form, memory_type: event.target.value })}>{MEMORY_TYPES.map((type) => <option value={type} key={type}>{type.replaceAll('_', ' ')}</option>)}</select></label>
            <label><span>Instruction or fact</span><textarea required rows={4} placeholder="Never call this a health drink. Call it a traditional grain mix." value={form.statement} onChange={(event) => setForm({ ...form, statement: event.target.value })} /></label>
            <div className="memory-form-grid"><label><span>Durability</span><select value={form.durability} onChange={(event) => setForm({ ...form, durability: event.target.value })}><option>permanent</option><option>stable</option><option>temporary</option><option>experiment</option></select></label><label><span>Expiry, when needed</span><input type="date" value={form.valid_until} onChange={(event) => setForm({ ...form, valid_until: event.target.value })} /></label></div>
            <button className="memory-primary" disabled={busy}>Save confirmed rule</button>
          </form>
        </details>

        <details className="memory-section">
          <summary>Weekly learning review</summary>
          <div className="review-controls"><select value={selectedPlan} onChange={(event) => setSelectedPlan(event.target.value)}><option value="">Choose a completed week…</option>{plans.map((plan) => <option value={plan.id} key={plan.id}>{plan.week_start} · {plan.primary_goal} · {plan.status}</option>)}</select><button className="memory-primary" disabled={busy || !selectedPlan} onClick={createReview}>Analyse the week</button></div>
          {review && <article className="learning-review"><h3>{review.summary}</h3><h4>Observed</h4><ul>{review.observations.map((observation, index) => <li key={index}><strong>{observation.signal}</strong> — {observation.evidence}</li>)}</ul>{review.experiment_suggestions.length > 0 && <><h4>Experiments</h4><ul>{review.experiment_suggestions.map((experiment, index) => <li key={index}>{experiment.hypothesis}</li>)}</ul></>}</article>}
        </details>

        <details className="memory-section">
          <summary>Repetition intelligence <span>{warnings.length}</span></summary>
          {warnings.length === 0 ? <p className="memory-empty">No repeated hook, CTA or dominant pillar pattern is currently flagged.</p> : <ul className="repetition-list">{warnings.map((warning, index) => <li key={`${warning.type}-${index}`}><strong>{warning.type}</strong><span>{warning.message}</span><small>{warning.evidence}</small></li>)}</ul>}
        </details>

        <footer className="memory-footer"><button onClick={exportMemory} disabled={busy}>Export memory</button><button className="memory-danger" disabled={busy} onClick={() => void run(async () => { await api(`/api/v2/brands/${brand.id}/memory/reset`, { method: 'POST' }); await refresh(); }, 'All inferred memories were rejected; explicit rules were preserved.')}>Reset inferred learning</button></footer>
      </section>
    </div>}
  </>;
}
