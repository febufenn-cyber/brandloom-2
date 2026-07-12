import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { api } from './lib/api';
import { supabase } from './lib/supabase';

type Brand = { id: string; name: string; description: string; category: string; location: string; website_url: string; primary_language: string };
type Product = { id: string; name: string; description: string; approved_facts: string[]; restricted_claims: string[] };
type Audience = { id: string; name: string; description: string; objections: string[]; is_primary: boolean };
type Profile = {
  tone_attributes: Record<string, number>; preferred_phrases: string[]; prohibited_phrases: string[];
  approved_claims: string[]; prohibited_claims: string[]; positive_examples: string[];
  negative_examples: string[]; style_rules: Record<string, unknown>; constitution?: Record<string, unknown> | null;
};
type Plan = { id: string; week_start: string; primary_goal: string; campaign_context: string; status: string; strategy?: Strategy | null };
type Strategy = { narrative: string; rationale: string; days: Array<{ scheduled_date: string; title: string; topic: string; format: string; pillar: string }> };
type Item = {
  id: string; scheduled_date: string; format: string; pillar: string; title: string; hook: string; caption: string;
  cta: string; visual_brief: string; hashtags: string[]; status: string;
  quality_flags: Array<{ severity: 'warning' | 'error'; message: string }>;
};
type Bootstrap = {
  brand: Brand | null; profile?: Profile | null; products?: Product[]; audiences?: Audience[]; plans?: Plan[];
  readiness?: { score: number; strengths: string[]; missing: string[] };
};
type Tab = 'overview' | 'brand' | 'products' | 'audience' | 'constitution' | 'studio';

type Runner = (task: () => Promise<void>, message?: string) => Promise<void>;
const lines = (value: string) => value.split(/\n|,/).map((part) => part.trim()).filter(Boolean);
const weekStart = () => {
  const date = new Date();
  const day = date.getDay();
  date.setDate(date.getDate() - day + (day === 0 ? -6 : 1));
  return date.toISOString().slice(0, 10);
};

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [data, setData] = useState<Bootstrap | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void supabase.auth.getSession().then(({ data: auth }) => setSession(auth.session));
    const listener = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => listener.data.subscription.unsubscribe();
  }, []);

  const refresh = async () => setData(await api<Bootstrap>('/api/bootstrap'));
  useEffect(() => { if (session) void refresh().catch((reason) => setError(String(reason))); else setData(null); }, [session]);

  const run: Runner = async (task, success) => {
    setBusy(true); setError(''); setMessage('');
    try { await task(); if (success) setMessage(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  if (!session) return <Auth />;
  if (!data) return <Centered>Loading your workspace…</Centered>;
  if (!data.brand) return <Centered><CreateBrand run={run} refresh={refresh} busy={busy} /></Centered>;

  const brand = data.brand;
  const readiness = data.readiness ?? { score: 0, strengths: [], missing: [] };
  const tabs: Array<[Tab, string]> = [
    ['overview', 'Overview'], ['brand', 'Brand signal'], ['products', 'Products'],
    ['audience', 'Audience'], ['constitution', 'Constitution'], ['studio', 'Weekly studio'],
  ];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="wordmark"><span>BL</span><div>Brandloom<small>Brand intelligence studio</small></div></div>
      <nav>{tabs.map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</nav>
      <div className="sidebar-foot">
        <div className="score-ring" style={{ '--score': `${readiness.score * 3.6}deg` } as CSSProperties}><strong>{readiness.score}</strong><span>ready</span></div>
        <button className="text-button" onClick={() => void supabase.auth.signOut()}>Sign out</button>
      </div>
    </aside>
    <main>
      <header className="topbar"><div><p className="eyebrow">{brand.category || 'Your brand'}</p><h1>{brand.name}</h1></div><span className="phase">Phase 1 · Human-approved</span></header>
      {(error || message) && <div className={`alert ${error ? 'error' : 'success'}`}>{error || message}</div>}
      {tab === 'overview' && <Overview data={data} onNext={() => setTab(readiness.score < 55 ? 'brand' : 'studio')} />}
      {tab === 'brand' && <BrandSignal brand={brand} profile={data.profile ?? null} run={run} refresh={refresh} busy={busy} />}
      {tab === 'products' && <Products brandId={brand.id} products={data.products ?? []} run={run} refresh={refresh} busy={busy} />}
      {tab === 'audience' && <Audiences brandId={brand.id} audiences={data.audiences ?? []} run={run} refresh={refresh} busy={busy} />}
      {tab === 'constitution' && <Constitution brandId={brand.id} profile={data.profile ?? null} readiness={readiness.score} run={run} refresh={refresh} busy={busy} />}
      {tab === 'studio' && <Studio brand={brand} profile={data.profile ?? null} products={data.products ?? []} savedPlans={data.plans ?? []} run={run} busy={busy} />}
    </main>
  </div>;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="center-shell"><div className="auth-brand"><span>BL</span><h1>Brandloom</h1><p>Build the brand system before producing content.</p></div>{children}</div>;
}

function Auth() {
  const [signup, setSignup] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = signup
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });
    setNote(result.error?.message ?? (signup ? 'Check your inbox to confirm the account.' : 'Signed in.'));
  };
  return <Centered><form className="panel auth-card" onSubmit={submit}>
    <h2>{signup ? 'Create your studio' : 'Welcome back'}</h2>
    <p className="muted">Approved facts remain separate from generated language.</p>
    <Field label="Email"><input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
    <Field label="Password"><input type="password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
    <button className="primary">{signup ? 'Create account' : 'Sign in'}</button>
    {note && <p className="form-message">{note}</p>}
    <button type="button" className="text-button" onClick={() => setSignup(!signup)}>{signup ? 'Already registered?' : 'Create an account'}</button>
  </form></Centered>;
}

function CreateBrand({ run, refresh, busy }: { run: Runner; refresh: () => Promise<void>; busy: boolean }) {
  const [form, setForm] = useState({ name: '', description: '', category: '', location: '', website_url: '', primary_language: 'English', secondary_languages: [] });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => { await api('/api/brands', { method: 'POST', body: JSON.stringify(form) }); await refresh(); }, 'Brand workspace created.');
  };
  return <form className="panel setup-card" onSubmit={submit}>
    <p className="eyebrow">Opening move</p><h2>Create the source of truth</h2>
    <div className="grid two">
      <Field label="Brand name"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
      <Field label="Category"><input value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} /></Field>
    </div>
    <Field label="What does the business do?"><textarea rows={4} required value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
    <div className="grid two">
      <Field label="Location"><input value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} /></Field>
      <Field label="Website"><input type="url" value={form.website_url} onChange={(event) => setForm({ ...form, website_url: event.target.value })} /></Field>
    </div>
    <button className="primary" disabled={busy}>Create workspace</button>
  </form>;
}

function Overview({ data, onNext }: { data: Bootstrap; onNext: () => void }) {
  const readiness = data.readiness!;
  return <section>
    <div className="hero-card"><div><p className="eyebrow">Position before production</p><h2>Your brand signal is {readiness.score}% ready.</h2><p>Missing information stays visible instead of becoming model invention.</p><button className="primary" onClick={onNext}>{readiness.score < 55 ? 'Strengthen brand signal' : 'Build this week'}</button></div><div className="readiness"><strong>{readiness.score}</strong><span>/100</span></div></div>
    <div className="grid three metrics"><Metric label="Products" value={data.products?.length ?? 0} note="approved facts" /><Metric label="Audiences" value={data.audiences?.length ?? 0} note="motives and objections" /><Metric label="Constitution" value={data.profile?.constitution ? 'Ready' : 'Missing'} note="brand source of truth" /></div>
    <div className="grid two"><PanelList title="Strong squares" items={readiness.strengths} className="check-list" /><PanelList title="Blind spots" items={readiness.missing} className="gap-list" /></div>
  </section>;
}

function BrandSignal({ brand, profile, run, refresh, busy }: { brand: Brand; profile: Profile | null; run: Runner; refresh: () => Promise<void>; busy: boolean }) {
  const [description, setDescription] = useState(brand.description);
  const [category, setCategory] = useState(brand.category);
  const [location, setLocation] = useState(brand.location);
  const [preferred, setPreferred] = useState((profile?.preferred_phrases ?? []).join('\n'));
  const [prohibited, setProhibited] = useState((profile?.prohibited_phrases ?? []).join('\n'));
  const [positive, setPositive] = useState((profile?.positive_examples ?? []).join('\n---\n'));
  const [negative, setNegative] = useState((profile?.negative_examples ?? []).join('\n---\n'));
  const [tone, setTone] = useState(profile?.tone_attributes ?? { warmth: 70, formality: 35, playfulness: 30, tradition: 60 });
  const save = () => run(async () => {
    await api(`/api/brands/${brand.id}`, { method: 'PATCH', body: JSON.stringify({ description, category, location }) });
    await api(`/api/brands/${brand.id}/voice-profile`, { method: 'PUT', body: JSON.stringify({
      tone_attributes: tone, preferred_phrases: lines(preferred), prohibited_phrases: lines(prohibited),
      positive_examples: positive.split('\n---\n').map((value) => value.trim()).filter(Boolean),
      negative_examples: negative.split('\n---\n').map((value) => value.trim()).filter(Boolean),
      style_rules: profile?.style_rules ?? {}, approved_claims: profile?.approved_claims ?? [], prohibited_claims: profile?.prohibited_claims ?? [],
    }) });
    await refresh();
  }, 'Brand signal saved.');
  return <section><Head eyebrow="Brand intelligence interview" title="Facts, contrasts and examples" text="A useful voice is defined by what it sounds like and what it refuses to sound like." />
    <div className="panel"><div className="grid two"><Field label="Category"><input value={category} onChange={(event) => setCategory(event.target.value)} /></Field><Field label="Location"><input value={location} onChange={(event) => setLocation(event.target.value)} /></Field></div><Field label="Business description"><textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} /></Field></div>
    <div className="panel"><h3>Voice contrasts</h3><div className="slider-grid">{Object.entries(tone).map(([key, value]) => <label key={key}><span>{key}<strong>{value}</strong></span><input type="range" min="0" max="100" value={value} onChange={(event) => setTone({ ...tone, [key]: Number(event.target.value) })} /></label>)}</div>
      <div className="grid two"><Field label="Preferred phrases"><textarea rows={5} value={preferred} onChange={(event) => setPreferred(event.target.value)} /></Field><Field label="Never use"><textarea rows={5} value={prohibited} onChange={(event) => setProhibited(event.target.value)} /></Field></div>
      <div className="grid two"><Field label="Examples that sound right"><textarea rows={5} value={positive} onChange={(event) => setPositive(event.target.value)} /></Field><Field label="Examples that sound wrong"><textarea rows={5} value={negative} onChange={(event) => setNegative(event.target.value)} /></Field></div>
      <button className="primary" disabled={busy} onClick={() => void save()}>Save brand signal</button>
    </div>
  </section>;
}

function Products({ brandId, products, run, refresh, busy }: { brandId: string; products: Product[]; run: Runner; refresh: () => Promise<void>; busy: boolean }) {
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [facts, setFacts] = useState(''); const [forbidden, setForbidden] = useState('');
  const add = (event: FormEvent) => { event.preventDefault(); void run(async () => {
    await api(`/api/brands/${brandId}/products`, { method: 'POST', body: JSON.stringify({ name, description, customer_problem: '', benefits: [], approved_facts: lines(facts), restricted_claims: lines(forbidden), price: '', purchase_url: '', active: true }) });
    setName(''); setDescription(''); setFacts(''); setForbidden(''); await refresh();
  }, 'Product added.'); };
  return <section><Head eyebrow="Fact boundary" title="Product library" text="Only facts approved here may become factual claims." />
    <div className="grid cards">{products.map((product) => <article className="panel" key={product.id}><h3>{product.name}</h3><p>{product.description}</p><h4>Approved facts</h4><ul>{product.approved_facts.map((fact) => <li key={fact}>{fact}</li>)}</ul><h4>Restricted claims</h4><ul className="danger-list">{product.restricted_claims.map((claim) => <li key={claim}>{claim}</li>)}</ul></article>)}</div>
    <form className="panel" onSubmit={add}><h3>Add a product</h3><Field label="Name"><input required value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Description"><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></Field><div className="grid two"><Field label="Approved facts"><textarea rows={5} value={facts} onChange={(event) => setFacts(event.target.value)} /></Field><Field label="Claims to forbid"><textarea rows={5} value={forbidden} onChange={(event) => setForbidden(event.target.value)} /></Field></div><button className="primary" disabled={busy}>Add product</button></form>
  </section>;
}

function Audiences({ brandId, audiences, run, refresh, busy }: { brandId: string; audiences: Audience[]; run: Runner; refresh: () => Promise<void>; busy: boolean }) {
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [pain, setPain] = useState(''); const [motives, setMotives] = useState(''); const [objections, setObjections] = useState('');
  const add = (event: FormEvent) => { event.preventDefault(); void run(async () => {
    await api(`/api/brands/${brandId}/audiences`, { method: 'POST', body: JSON.stringify({ name, description, pain_points: lines(pain), motivations: lines(motives), objections: lines(objections), language_notes: '', is_primary: audiences.length === 0 }) });
    setName(''); setDescription(''); setPain(''); setMotives(''); setObjections(''); await refresh();
  }, 'Audience added.'); };
  return <section><Head eyebrow="Who is across the board?" title="Audience cards" text="Define the real buyer's motives and resistance." />
    <div className="grid cards">{audiences.map((audience) => <article className="panel" key={audience.id}><div className="card-row"><h3>{audience.name}</h3>{audience.is_primary && <span className="status">Primary</span>}</div><p>{audience.description}</p><h4>Objections</h4><ul>{audience.objections.map((value) => <li key={value}>{value}</li>)}</ul></article>)}</div>
    <form className="panel" onSubmit={add}><h3>Add an audience</h3><Field label="Audience name"><input required value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Description"><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></Field><div className="grid three"><Field label="Pain points"><textarea rows={5} value={pain} onChange={(event) => setPain(event.target.value)} /></Field><Field label="Motivations"><textarea rows={5} value={motives} onChange={(event) => setMotives(event.target.value)} /></Field><Field label="Objections"><textarea rows={5} value={objections} onChange={(event) => setObjections(event.target.value)} /></Field></div><button className="primary" disabled={busy}>Add audience</button></form>
  </section>;
}

function Constitution({ brandId, profile, readiness, run, refresh, busy }: { brandId: string; profile: Profile | null; readiness: number; run: Runner; refresh: () => Promise<void>; busy: boolean }) {
  const generate = () => run(async () => { await api(`/api/brands/${brandId}/constitution/generate`, { method: 'POST' }); await refresh(); }, 'Brand Constitution generated.');
  return <section><Head eyebrow="The position in one document" title="Brand Constitution" text="The model interprets; the owner remains the authority." />
    <div className="panel constitution-head"><div><h3>Readiness: {readiness}/100</h3><p className="muted">Weak inputs remain visible.</p></div><button className="primary" disabled={busy} onClick={() => void generate()}>{profile?.constitution ? 'Regenerate' : 'Generate constitution'}</button></div>
    {profile?.constitution ? <div className="constitution-grid">{Object.entries(profile.constitution).map(([key, value]) => <article className="panel" key={key}><p className="eyebrow">{key.replaceAll('_', ' ')}</p>{typeof value === 'string' ? <p>{value}</p> : <pre>{JSON.stringify(value, null, 2)}</pre>}</article>)}</div> : <div className="empty-state">Add products, an audience and voice examples first.</div>}
  </section>;
}

function Studio({ brand, profile, products, savedPlans, run, busy }: { brand: Brand; profile: Profile | null; products: Product[]; savedPlans: Plan[]; run: Runner; busy: boolean }) {
  const [plan, setPlan] = useState<Plan | null>(null); const [items, setItems] = useState<Item[]>([]);
  const [form, setForm] = useState({ brand_id: brand.id, week_start: weekStart(), primary_goal: 'trust', secondary_goal: '', campaign_context: '', featured_product_ids: [] as string[], important_dates: [], posting_days: 7, language_mode: brand.primary_language });
  if (!profile?.constitution) return <section><Head eyebrow="Weekly studio" title="Constitution required" text="Create the source of truth before asking the writer to act." /></section>;
  const create = () => run(async () => { const newPlan = await api<Plan>('/api/weekly-plans', { method: 'POST', body: JSON.stringify(form) }); setPlan(await api<Plan>(`/api/weekly-plans/${newPlan.id}/strategy/generate`, { method: 'POST' })); setItems([]); }, 'Weekly strategy ready.');
  const reopen = (id: string) => run(async () => { const result = await api<{ plan: Plan; items: Item[] }>(`/api/weekly-plans/${id}`); setPlan(result.plan); setItems(result.items); }, 'Saved week reopened.');
  const draft = () => plan && run(async () => { const result = await api<{ items: Item[] }>(`/api/weekly-plans/${plan.id}/posts/generate`, { method: 'POST' }); setItems(result.items); }, 'Drafts generated and checked.');
  return <section><Head eyebrow="Strategy before copy" title="Build one coherent week" text="Choose the objective, approve the plan, then generate drafts." />
    {savedPlans.length > 0 && <div className="panel saved-plans"><div><p className="eyebrow">Saved weeks</p><p className="muted">Reopen work after a refresh.</p></div><select defaultValue="" onChange={(event) => event.target.value && void reopen(event.target.value)}><option value="">Choose a week…</option>{savedPlans.map((saved) => <option value={saved.id} key={saved.id}>{saved.week_start} · {saved.primary_goal} · {saved.status}</option>)}</select></div>}
    <div className="panel"><div className="grid three"><Field label="Week starts"><input type="date" value={form.week_start} onChange={(event) => setForm({ ...form, week_start: event.target.value })} /></Field><Field label="Goal"><select value={form.primary_goal} onChange={(event) => setForm({ ...form, primary_goal: event.target.value })}>{['awareness','product','sales','education','trust','event','leads','reengagement'].map((goal) => <option key={goal}>{goal}</option>)}</select></Field><Field label="Posts"><input type="number" min="1" max="7" value={form.posting_days} onChange={(event) => setForm({ ...form, posting_days: Number(event.target.value) })} /></Field></div><Field label="What matters this week?"><textarea rows={4} value={form.campaign_context} onChange={(event) => setForm({ ...form, campaign_context: event.target.value })} /></Field><div className="product-select"><span>Featured products</span>{products.map((product) => <label className="checkbox" key={product.id}><input type="checkbox" checked={form.featured_product_ids.includes(product.id)} onChange={(event) => setForm({ ...form, featured_product_ids: event.target.checked ? [...form.featured_product_ids, product.id] : form.featured_product_ids.filter((id) => id !== product.id) })} />{product.name}</label>)}</div><button className="primary" disabled={busy} onClick={() => void create()}>Generate strategy</button></div>
    {plan?.strategy && <div className="panel strategy"><div className="card-row"><div><p className="eyebrow">Weekly narrative</p><h3>{plan.strategy.narrative}</h3></div><button className="primary" disabled={busy} onClick={() => void draft()}>Approve plan & draft posts</button></div><p>{plan.strategy.rationale}</p><div className="timeline">{plan.strategy.days.map((day) => <article key={day.scheduled_date}><span>{day.scheduled_date}</span><strong>{day.title}</strong><p>{day.topic}</p><small>{day.format} · {day.pillar}</small></article>)}</div></div>}
    <div className="content-stack">{items.map((item) => <Editor key={item.id} initial={item} run={run} onUpdate={(updated) => setItems((all) => all.map((entry) => entry.id === updated.id ? updated : entry))} />)}</div>
  </section>;
}

function Editor({ initial, run, onUpdate }: { initial: Item; run: Runner; onUpdate: (item: Item) => void }) {
  const [item, setItem] = useState(initial);
  const save = (status = item.status) => run(async () => { const updated = await api<Item>(`/api/content-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ title: item.title, hook: item.hook, caption: item.caption, cta: item.cta, visual_brief: item.visual_brief, hashtags: item.hashtags, status }) }); setItem(updated); onUpdate(updated); }, status === 'approved' ? 'Post approved.' : 'Draft saved.');
  const rewriteHook = () => run(async () => { const updated = await api<Item>(`/api/content-items/${item.id}/regenerate`, { method: 'POST', body: JSON.stringify({ fields: ['hook'], instruction: '' }) }); setItem(updated); onUpdate(updated); }, 'Hook regenerated.');
  return <article className="panel editor"><div className="card-row"><div><p className="eyebrow">{item.scheduled_date} · {item.format} · {item.pillar}</p><input className="title-input" value={item.title} onChange={(event) => setItem({ ...item, title: event.target.value })} /></div><span className={`status ${item.status}`}>{item.status}</span></div>
    {item.quality_flags?.length > 0 && <div className="flags">{item.quality_flags.map((flag, index) => <span className={flag.severity} key={index}>{flag.message}</span>)}</div>}
    <Field label="Hook"><div className="field-action"><textarea rows={2} value={item.hook} onChange={(event) => setItem({ ...item, hook: event.target.value })} /><button className="ghost" onClick={() => void rewriteHook()}>Rewrite</button></div></Field>
    <Field label="Caption"><textarea rows={8} value={item.caption} onChange={(event) => setItem({ ...item, caption: event.target.value })} /></Field>
    <div className="grid two"><Field label="Call to action"><input value={item.cta} onChange={(event) => setItem({ ...item, cta: event.target.value })} /></Field><Field label="Hashtags"><input value={item.hashtags.join(' ')} onChange={(event) => setItem({ ...item, hashtags: event.target.value.split(/\s+/).filter(Boolean) })} /></Field></div>
    <Field label="Visual brief"><textarea rows={3} value={item.visual_brief} onChange={(event) => setItem({ ...item, visual_brief: event.target.value })} /></Field>
    <div className="editor-actions"><button className="ghost" onClick={() => void save()}>Save edits</button><button className="primary" onClick={() => void save('approved')}>Approve</button><select defaultValue="" onChange={(event) => { const feedback = event.target.value; if (feedback) void run(() => api(`/api/content-items/${item.id}/feedback`, { method: 'POST', body: JSON.stringify({ feedback_type: feedback, comment: '' }) }), 'Feedback captured.'); event.target.value = ''; }}><option value="">Give feedback…</option>{['too_generic','too_formal','too_salesy','factually_incorrect','repetitive','off_brand','unsupported_claim','strong_example'].map((value) => <option value={value} key={value}>{value.replaceAll('_', ' ')}</option>)}</select></div>
  </article>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }
function Head({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) { return <header className="section-head"><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p>{text}</p></header>; }
function Metric({ label, value, note }: { label: string; value: string | number; note: string }) { return <div className="panel metric"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>; }
function PanelList({ title, items, className }: { title: string; items: string[]; className: string }) { return <div className="panel"><h3>{title}</h3><ul className={className}>{items.map((item) => <li key={item}>{item}</li>)}</ul></div>; }
