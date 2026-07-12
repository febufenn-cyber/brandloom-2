import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from './lib/api';
import { supabase } from './lib/supabase';

type Brand = { id: string; workspace_id: string; name: string };
type Campaign = { id: string; name: string; objective: string; start_date: string; end_date: string; key_message: string; status: string };
type Health = { completion: number; blocked: number; overdue: number; at_risk: boolean };
type ContentItem = { id: string; campaign_id?: string | null; title: string; scheduled_date: string; format: string; workflow_status: string; owner_id?: string | null; material_revision: number };
type Task = { id: string; campaign_id?: string | null; content_item_id?: string | null; title: string; status: string; due_at?: string | null; blocks_completion: boolean; owner_id?: string | null };
type Asset = { id: string; campaign_id?: string | null; name: string; asset_type: string; approved: boolean; rights_status: string; storage_path: string };
type Approval = { id: string; content_item_id: string; approval_type: string; status: string; requested_at: string; content_items?: { title: string; brand_id: string } | null };
type Member = { id: string; user_id: string; role: string; status: string };
type Deliverable = { id: string; campaign_id: string; title: string; deliverable_type: string; status: string; due_date?: string | null };
type Activity = { id: string; event_type: string; entity_type: string; created_at: string };
type OpsData = { campaigns: Campaign[]; campaign_health: Record<string, Health>; deliverables: Deliverable[]; content: ContentItem[]; tasks: Task[]; assets: Asset[]; approvals: Approval[]; members: Member[]; activity: Activity[] };
type CampaignDetail = { campaign: Campaign; deliverables: Deliverable[]; content: ContentItem[]; tasks: Task[]; assets: Asset[]; health: Health };
type Checklist = { id: string; label: string; category: string; required: boolean; completed: boolean };
type ContentDetail = {
  content: ContentItem & { hook: string; caption: string; cta: string; visual_brief: string };
  readiness: { overall: number; dimensions: Record<string, number>; blockers: number; ready_to_publish: boolean };
  checklist: Checklist[];
  assets: Array<{ asset_id: string; role: string }>;
  approvals: Approval[];
  tasks: Task[];
  threads: Array<{ id: string; field: string; status: string; blocks_approval: boolean }>;
};
type Tab = 'dashboard' | 'campaigns' | 'work' | 'assets' | 'reviews' | 'team';
type Runner = (task: () => Promise<void>, success?: string) => Promise<void>;

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (days: number) => { const date = new Date(); date.setDate(date.getDate() + days); return date.toISOString().slice(0, 10); };

export default function OperationsApp({ onBack }: { onBack: () => void }) {
  const [brand, setBrand] = useState<Brand | null>(null);
  const [data, setData] = useState<OpsData | null>(null);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [campaignDetail, setCampaignDetail] = useState<CampaignDetail | null>(null);
  const [contentDetail, setContentDetail] = useState<ContentDetail | null>(null);

  const refresh = async () => {
    const boot = await api<{ brand: Brand | null }>('/api/bootstrap');
    setBrand(boot.brand);
    if (boot.brand) setData(await api<OpsData>(`/api/v3/brands/${boot.brand.id}/operations`));
  };

  useEffect(() => { void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }, []);

  const run: Runner = async (task, success) => {
    setBusy(true); setError(''); setMessage('');
    try { await task(); if (success) setMessage(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const openCampaign = (id: string) => run(async () => { setCampaignDetail(await api<CampaignDetail>(`/api/v3/campaigns/${id}`)); }, 'Campaign opened.');
  const openContent = (id: string) => run(async () => { setContentDetail(await api<ContentDetail>(`/api/v3/content-items/${id}/operations`)); });
  const reloadAll = async () => {
    await refresh();
    if (campaignDetail) setCampaignDetail(await api<CampaignDetail>(`/api/v3/campaigns/${campaignDetail.campaign.id}`));
    if (contentDetail) setContentDetail(await api<ContentDetail>(`/api/v3/content-items/${contentDetail.content.id}/operations`));
  };

  if (!brand || !data) return <div className="center-shell">{error || 'Loading operations…'}</div>;
  const tabs: Array<[Tab, string]> = [['dashboard','Command centre'],['campaigns','Campaigns'],['work','Work board'],['assets','Assets'],['reviews','Review inbox'],['team','Team']];

  return <div className="ops-shell">
    <header className="ops-top"><div className="ops-brand"><span className="ops-brand-mark">BL</span><div><strong>{brand.name}</strong><small>Content operations</small></div></div><div className="ops-actions"><button onClick={() => void refresh()}>Refresh</button><button onClick={onBack}>Back to studio</button></div></header>
    <div className="ops-layout">
      <nav className="ops-nav">{tabs.map(([key,label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</nav>
      <main className="ops-main">
        {(error || message) && <div className={`ops-alert ${error ? 'error' : ''}`}>{error || message}</div>}
        {tab === 'dashboard' && <Dashboard data={data} onCampaign={(id) => { setTab('campaigns'); void openCampaign(id); }} />}
        {tab === 'campaigns' && <Campaigns brand={brand} data={data} detail={campaignDetail} run={run} busy={busy} refresh={reloadAll} openCampaign={openCampaign} openContent={openContent} />}
        {tab === 'work' && <WorkBoard brand={brand} data={data} run={run} busy={busy} refresh={reloadAll} openContent={openContent} />}
        {tab === 'assets' && <Assets brand={brand} data={data} run={run} busy={busy} refresh={reloadAll} />}
        {tab === 'reviews' && <Reviews data={data} run={run} busy={busy} refresh={reloadAll} />}
        {tab === 'team' && <Team brand={brand} data={data} run={run} busy={busy} refresh={reloadAll} />}
      </main>
    </div>
    {contentDetail && <ContentDrawer detail={contentDetail} data={data} run={run} busy={busy} refresh={reloadAll} close={() => setContentDetail(null)} />}
  </div>;
}

function Dashboard({ data, onCampaign }: { data: OpsData; onCampaign: (id: string) => void }) {
  const active = data.campaigns.filter((item) => ['active','planned','at_risk'].includes(item.status));
  const blocked = data.tasks.filter((item) => item.status === 'blocked').length + data.content.filter((item) => item.workflow_status === 'blocked').length;
  const overdue = data.tasks.filter((item) => item.status !== 'done' && item.due_at && item.due_at.slice(0,10) < today()).length;
  const ready = data.content.filter((item) => ['approved','ready_to_publish'].includes(item.workflow_status)).length;
  return <section><OpsHead title="Command centre" text="See what is ready, blocked, awaiting review or drifting past its deadline." />
    <div className="ops-grid four"><Metric value={active.length} label="Active campaigns" /><Metric value={data.approvals.filter((item) => item.status === 'pending').length} label="Awaiting your review" /><Metric value={blocked} label="Blocked work" /><Metric value={ready} label="Approved handoffs" /></div>
    {overdue > 0 && <div className="ops-alert error">{overdue} task{overdue === 1 ? '' : 's'} overdue.</div>}
    <div className="ops-grid two"><div className="ops-card"><h2>Campaign health</h2><div className="ops-list">{active.map((campaign) => { const health = data.campaign_health[campaign.id] ?? {completion:0,blocked:0,overdue:0,at_risk:false}; return <button className="ops-list-item clickable" key={campaign.id} onClick={() => onCampaign(campaign.id)}><div className="ops-row"><strong>{campaign.name}</strong><span className={`ops-badge ${health.at_risk ? 'risk' : 'good'}`}>{health.at_risk ? 'At risk' : 'On track'}</span></div><div className="ops-progress"><span style={{width:`${health.completion}%`}} /></div><small>{health.completion}% complete · {health.blocked} blocked · {health.overdue} overdue</small></button>; })}{active.length === 0 && <p>No active campaigns.</p>}</div></div>
      <div className="ops-card"><h2>Recent activity</h2><div className="ops-list">{data.activity.slice(0,10).map((item) => <div className="ops-list-item" key={item.id}><strong>{item.event_type.replaceAll('.',' · ')}</strong><small>{new Date(item.created_at).toLocaleString()}</small></div>)}</div></div></div>
  </section>;
}

function Campaigns({ brand, data, detail, run, busy, refresh, openCampaign, openContent }: { brand: Brand; data: OpsData; detail: CampaignDetail | null; run: Runner; busy: boolean; refresh: () => Promise<void>; openCampaign: (id:string) => Promise<void>; openContent: (id:string) => Promise<void> }) {
  const [form, setForm] = useState({ name:'', objective:'', start_date:today(), end_date:plusDays(14), key_message:'', audience_ids:[], product_ids:[], offer_details:{}, campaign_facts:[], restrictions:[], deliverable_targets:{}, capacity:{}, status:'planned' });
  const create = (event: FormEvent) => { event.preventDefault(); void run(async () => { const campaign = await api<Campaign>(`/api/v3/brands/${brand.id}/campaigns`, {method:'POST',body:JSON.stringify(form)}); setForm({...form,name:'',objective:'',key_message:''}); await refresh(); await openCampaign(campaign.id); }, 'Campaign created.'); };
  return <section><OpsHead title="Campaigns" text="Campaign facts expire with the campaign instead of leaking into permanent brand memory." />
    <div className="ops-grid two"><form className="ops-card" onSubmit={create}><h2>New campaign</h2><Field label="Name"><input required value={form.name} onChange={(event) => setForm({...form,name:event.target.value})} /></Field><Field label="Objective"><textarea rows={3} value={form.objective} onChange={(event) => setForm({...form,objective:event.target.value})} /></Field><div className="ops-grid two"><Field label="Starts"><input type="date" value={form.start_date} onChange={(event) => setForm({...form,start_date:event.target.value})} /></Field><Field label="Ends"><input type="date" value={form.end_date} onChange={(event) => setForm({...form,end_date:event.target.value})} /></Field></div><Field label="Key message"><textarea rows={2} value={form.key_message} onChange={(event) => setForm({...form,key_message:event.target.value})} /></Field><button className="ops-button" disabled={busy}>Create campaign</button></form>
      <div><h2>Portfolio</h2>{data.campaigns.map((campaign) => <article className="ops-card clickable" key={campaign.id} onClick={() => void openCampaign(campaign.id)}><div className="ops-row"><div><h3>{campaign.name}</h3><p>{campaign.objective || 'Objective not set'}</p></div><span className="ops-badge">{campaign.status}</span></div><small>{campaign.start_date} → {campaign.end_date}</small></article>)}</div></div>
    {detail && <CampaignWorkspace detail={detail} run={run} busy={busy} refresh={refresh} openContent={openContent} />}
  </section>;
}

function CampaignWorkspace({ detail, run, busy, refresh, openContent }: { detail: CampaignDetail; run: Runner; busy: boolean; refresh: () => Promise<void>; openContent:(id:string)=>Promise<void> }) {
  const [content, setContent] = useState({ title:'',scheduled_date:detail.campaign.start_date,format:'static',pillar:'campaign',objective:'',hook:'',caption:'',cta:'',visual_brief:'',hashtags:[],structure:{} });
  const generateBrief = () => run(async () => { await api(`/api/v3/campaigns/${detail.campaign.id}/brief/generate`, {method:'POST'}); await refresh(); }, 'Campaign brief generated.');
  const addContent = (event: FormEvent) => { event.preventDefault(); void run(async () => { const created = await api<ContentDetail>(`/api/v3/campaigns/${detail.campaign.id}/content`, {method:'POST',body:JSON.stringify(content)}); setContent({...content,title:'',hook:'',caption:'',cta:'',visual_brief:''}); await refresh(); await openContent(created.content.id); }, 'Deliverable created.'); };
  return <div className="ops-card"><div className="ops-row"><div><p className="eyebrow">Campaign workspace</p><h2>{detail.campaign.name}</h2><p>{detail.campaign.key_message || detail.campaign.objective}</p></div><div><span className={`ops-badge ${detail.health.at_risk ? 'risk' : 'good'}`}>{detail.health.at_risk ? 'At risk' : 'On track'}</span><button className="ops-button secondary" disabled={busy} onClick={() => void generateBrief()}>Generate brief</button></div></div>
    <div className="ops-progress"><span style={{width:`${detail.health.completion}%`}} /></div>
    <div className="ops-grid two"><div><h3>Deliverables</h3>{detail.content.map((item) => <div className="ops-list-item clickable" key={item.id} onClick={() => void openContent(item.id)}><div className="ops-row"><strong>{item.title}</strong><span className="ops-badge">{item.workflow_status}</span></div><small>{item.scheduled_date} · {item.format}</small></div>)}{detail.content.length === 0 && <p>No content yet.</p>}</div>
      <form onSubmit={addContent}><h3>Add campaign content</h3><Field label="Title"><input required value={content.title} onChange={(event) => setContent({...content,title:event.target.value})} /></Field><div className="ops-grid two"><Field label="Date"><input type="date" value={content.scheduled_date} onChange={(event) => setContent({...content,scheduled_date:event.target.value})} /></Field><Field label="Format"><select value={content.format} onChange={(event) => setContent({...content,format:event.target.value})}>{['static','carousel','reel','story'].map((value) => <option key={value}>{value}</option>)}</select></Field></div><Field label="Hook"><input value={content.hook} onChange={(event) => setContent({...content,hook:event.target.value})} /></Field><Field label="Caption"><textarea rows={4} value={content.caption} onChange={(event) => setContent({...content,caption:event.target.value})} /></Field><Field label="Visual brief"><textarea rows={2} value={content.visual_brief} onChange={(event) => setContent({...content,visual_brief:event.target.value})} /></Field><button className="ops-button" disabled={busy}>Create deliverable</button></form></div>
  </div>;
}

function WorkBoard({ brand, data, run, busy, refresh, openContent }: { brand:Brand; data:OpsData; run:Runner; busy:boolean; refresh:()=>Promise<void>; openContent:(id:string)=>Promise<void> }) {
  const groups: Array<[string,string[]]> = [['Planning',['idea','planned','drafting']],['Review',['internal_review','changes_requested','ready_for_approval']],['Approved',['approved','ready_to_publish']],['Closed',['completed','blocked','cancelled','expired']]];
  const [task, setTask] = useState({title:'',description:'',task_type:'general',status:'todo',blocks_completion:false,campaign_id:null,content_item_id:null,owner_id:null,due_at:null});
  const addTask = (event:FormEvent) => { event.preventDefault(); void run(async () => { await api(`/api/v3/brands/${brand.id}/tasks`,{method:'POST',body:JSON.stringify(task)}); setTask({...task,title:'',description:''}); await refresh(); },'Task created.'); };
  return <section><OpsHead title="Work board" text="A post is complete only when copy, assets, checklists and current-version approvals are complete." />
    <div className="ops-board">{groups.map(([label,statuses]) => <div className="ops-column" key={label}><h3>{label}</h3>{data.content.filter((item) => statuses.includes(item.workflow_status)).map((item) => <div className="ops-ticket" key={item.id} onClick={() => void openContent(item.id)}><strong>{item.title}</strong><small>{item.scheduled_date} · {item.format}</small><span className="ops-badge">{item.workflow_status}</span></div>)}</div>)}</div>
    <div className="ops-grid two"><div className="ops-card"><h2>Tasks</h2><div className="ops-list">{data.tasks.map((item) => <div className={`ops-list-item ${item.status === 'done' ? 'done' : ''}`} key={item.id}><div className="ops-row"><div><strong>{item.title}</strong><small>{item.due_at ? new Date(item.due_at).toLocaleString() : 'No deadline'}{item.blocks_completion ? ' · blocks completion' : ''}</small></div><select value={item.status} onChange={(event) => void run(async () => { await api(`/api/v3/tasks/${item.id}`,{method:'PATCH',body:JSON.stringify({status:event.target.value})}); await refresh(); },'Task updated.')}>{['todo','in_progress','blocked','done','cancelled'].map((value) => <option key={value}>{value}</option>)}</select></div></div>)}</div></div>
      <form className="ops-card" onSubmit={addTask}><h2>Add task</h2><Field label="Task"><input required value={task.title} onChange={(event) => setTask({...task,title:event.target.value})} /></Field><Field label="Description"><textarea rows={3} value={task.description} onChange={(event) => setTask({...task,description:event.target.value})} /></Field><label><input type="checkbox" checked={task.blocks_completion} onChange={(event) => setTask({...task,blocks_completion:event.target.checked})} /> Blocks completion</label><button className="ops-button" disabled={busy}>Create task</button></form></div>
  </section>;
}

function Assets({ brand, data, run, busy, refresh }: { brand:Brand; data:OpsData; run:Runner; busy:boolean; refresh:()=>Promise<void> }) {
  const [file,setFile]=useState<File|null>(null); const [rights,setRights]=useState('owned');
  const upload = (event:FormEvent) => { event.preventDefault(); if(!file)return; void run(async () => { const signed = await api<{asset:Asset;upload:{path:string;token:string}}>(`/api/v3/brands/${brand.id}/assets/upload-url`,{method:'POST',body:JSON.stringify({name:file.name,asset_type:file.type.startsWith('video')?'video':file.type.startsWith('audio')?'audio':file.type==='application/pdf'?'document':'image',mime_type:file.type,size_bytes:file.size,tags:[],rights_status:rights})}); const result=await supabase.storage.from('brand-assets').uploadToSignedUrl(signed.upload.path,signed.upload.token,file,{contentType:file.type}); if(result.error)throw result.error; setFile(null); await refresh(); },'Asset uploaded.'); };
  return <section><OpsHead title="Asset library" text="Private, rights-aware assets make missing visual work visible before publication day." /><div className="ops-grid two"><form className="ops-card" onSubmit={upload}><h2>Upload asset</h2><Field label="File"><input type="file" required onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></Field><Field label="Rights"><select value={rights} onChange={(event)=>setRights(event.target.value)}>{['owned','licensed','restricted','unknown'].map((value)=><option key={value}>{value}</option>)}</select></Field><button className="ops-button" disabled={busy||!file}>Upload privately</button></form><div className="ops-grid two">{data.assets.map((asset)=><article className="ops-card" key={asset.id}><div className="ops-row"><strong>{asset.name}</strong><span className={`ops-badge ${asset.approved?'good':''}`}>{asset.approved?'approved':'pending'}</span></div><p>{asset.asset_type} · {asset.rights_status}</p></article>)}</div></div></section>;
}

function Reviews({ data, run, busy, refresh }: { data:OpsData; run:Runner; busy:boolean; refresh:()=>Promise<void> }) {
  const decide=(id:string,decision:string)=>run(async()=>{await api(`/api/v3/approval-requests/${id}/decision`,{method:'POST',body:JSON.stringify({decision,comment:''})});await refresh();},`Approval ${decision.replace('_',' ')}.`);
  return <section><OpsHead title="Review inbox" text="Every decision is tied to the exact content version that was reviewed." />{data.approvals.filter((item)=>item.status==='pending').map((item)=><article className="ops-card" key={item.id}><div className="ops-row"><div><h3>{item.content_items?.title ?? 'Content approval'}</h3><p>{item.approval_type} · requested {new Date(item.requested_at).toLocaleString()}</p></div><div><button className="ops-button secondary" disabled={busy} onClick={()=>void decide(item.id,'changes_requested')}>Request changes</button><button className="ops-button" disabled={busy} onClick={()=>void decide(item.id,'approved')}>Approve</button></div></div></article>)}{data.approvals.filter((item)=>item.status==='pending').length===0&&<div className="ops-empty">Nothing is waiting for your decision.</div>}</section>;
}

function Team({ brand, data, run, busy, refresh }: { brand:Brand; data:OpsData; run:Runner; busy:boolean; refresh:()=>Promise<void> }) {
  const [email,setEmail]=useState(''); const [role,setRole]=useState('reviewer'); const [token,setToken]=useState('');
  const invite=(event:FormEvent)=>{event.preventDefault();void run(async()=>{const result=await api<{token:string}>(`/api/v3/workspaces/${brand.workspace_id}/invitations`,{method:'POST',body:JSON.stringify({email,role,expires_in_days:7})});setToken(result.token);setEmail('');await refresh();},'Invitation created.');};
  return <section><OpsHead title="Team" text="Start with lightweight workspace roles instead of enterprise permission complexity." /><div className="ops-grid two"><div className="ops-card"><h2>Members</h2><div className="ops-list">{data.members.map((member)=><div className="ops-list-item" key={member.id}><div className="ops-row"><code>{member.user_id.slice(0,8)}…</code><span className="ops-badge">{member.role}</span></div></div>)}</div></div><form className="ops-card" onSubmit={invite}><h2>Invite collaborator</h2><Field label="Email"><input type="email" required value={email} onChange={(event)=>setEmail(event.target.value)} /></Field><Field label="Role"><select value={role} onChange={(event)=>setRole(event.target.value)}>{['admin','editor','reviewer','approver','viewer'].map((value)=><option key={value}>{value}</option>)}</select></Field><button className="ops-button" disabled={busy}>Create secure invite</button>{token&&<><p>Send this one-time token to the invited email:</p><div className="ops-token">{token}</div></>}</form></div></section>;
}

function ContentDrawer({ detail, data, run, busy, refresh, close }: { detail:ContentDetail; data:OpsData; run:Runner; busy:boolean; refresh:()=>Promise<void>; close:()=>void }) {
  const [comment,setComment]=useState(''); const [approver,setApprover]=useState(data.members.find((item)=>['owner','admin','approver'].includes(item.role))?.user_id ?? ''); const [asset,setAsset]=useState(data.assets[0]?.id ?? '');
  const updateStatus=(status:string)=>run(async()=>{await api(`/api/v3/content-items/${detail.content.id}/operations`,{method:'PATCH',body:JSON.stringify({workflow_status:status,acknowledge_warnings:true})});await refresh();},'Workflow updated.');
  const addComment=()=>run(async()=>{await api(`/api/v3/content-items/${detail.content.id}/threads`,{method:'POST',body:JSON.stringify({field:'general',change_type:'copy',blocks_approval:true,body:comment})});setComment('');await refresh();},'Change request added.');
  const requestApproval=()=>run(async()=>{await api(`/api/v3/content-items/${detail.content.id}/approval-requests`,{method:'POST',body:JSON.stringify({approver_id:approver,approval_type:'final',required:true,step_number:1})});await refresh();},'Approval requested.');
  const attach=()=>run(async()=>{await api(`/api/v3/content-items/${detail.content.id}/assets`,{method:'POST',body:JSON.stringify({asset_id:asset,role:'primary',required:true,position:0})});await refresh();},'Asset attached.');
  const exportItem=()=>run(async()=>{await api(`/api/v3/content-items/${detail.content.id}/export`,{method:'POST',body:JSON.stringify({export_format:'copy_package'})});await refresh();},'Publishing handoff exported.');
  return <aside className="ops-detail"><button className="ops-detail-close" onClick={close}>×</button><p className="eyebrow">Content operations</p><h2>{detail.content.title}</h2><div className="ops-row"><span className="ops-badge dark">{detail.content.workflow_status}</span><strong>{detail.readiness.overall}% ready</strong></div><div className="ops-progress"><span style={{width:`${detail.readiness.overall}%`}} /></div><div className="ops-dimensions">{Object.entries(detail.readiness.dimensions).map(([key,value])=><div className="ops-dimension" key={key}><strong>{value}%</strong><small>{key}</small></div>)}</div>{detail.readiness.blockers>0&&<div className="ops-alert error">{detail.readiness.blockers} blocker{detail.readiness.blockers===1?'':'s'} remain.</div>}
    <div className="ops-card"><h3>Workflow</h3><Field label="Move to"><select value={detail.content.workflow_status} onChange={(event)=>void updateStatus(event.target.value)}>{['idea','planned','drafting','internal_review','changes_requested','ready_for_approval','approved','ready_to_publish','completed','blocked','cancelled','expired'].map((value)=><option key={value}>{value}</option>)}</select></Field></div>
    <div className="ops-card"><h3>Completion checklist</h3><div className="ops-list">{detail.checklist.map((item)=><div className={`ops-list-item ${item.completed?'done':''}`} key={item.id}><label><input type="checkbox" checked={item.completed} onChange={(event)=>void run(async()=>{await api(`/api/v3/checklist-items/${item.id}`,{method:'PATCH',body:JSON.stringify({completed:event.target.checked})});await refresh();},'Checklist updated.')} /><span><strong>{item.label}</strong><small>{item.category}</small></span></label></div>)}</div></div>
    <div className="ops-card"><h3>Assets</h3>{data.assets.length?<><Field label="Attach asset"><select value={asset} onChange={(event)=>setAsset(event.target.value)}>{data.assets.map((item)=><option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><button className="ops-button secondary" onClick={()=>void attach()}>Attach</button></>:<p>No assets uploaded.</p>}</div>
    <div className="ops-card"><h3>Approval</h3>{data.members.length?<><Field label="Approver"><select value={approver} onChange={(event)=>setApprover(event.target.value)}>{data.members.map((item)=><option value={item.user_id} key={item.id}>{item.role} · {item.user_id.slice(0,8)}…</option>)}</select></Field><button className="ops-button" disabled={busy||!approver} onClick={()=>void requestApproval()}>Request version-bound approval</button></>:<p>No approver available.</p>}</div>
    <div className="ops-card"><h3>Request changes</h3><Field label="Comment"><textarea rows={3} value={comment} onChange={(event)=>setComment(event.target.value)} /></Field><button className="ops-button secondary" disabled={!comment} onClick={()=>void addComment()}>Create blocking review thread</button></div>
    <button className="ops-button" disabled={!['approved','ready_to_publish','completed'].includes(detail.content.workflow_status)} onClick={()=>void exportItem()}>Export publishing handoff</button>
  </aside>;
}

function OpsHead({title,text}:{title:string;text:string}){return <header className="ops-head"><div><p className="eyebrow">Phase 3</p><h1>{title}</h1><p>{text}</p></div></header>}
function Metric({value,label}:{value:number|string;label:string}){return <div className="ops-card ops-metric"><strong>{value}</strong><span>{label}</span></div>}
function Field({label,children}:{label:string;children:ReactNode}){return <label className="ops-field"><span>{label}</span>{children}</label>}
