import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { api } from './lib/api';
import { supabase } from './lib/supabase';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787';
const CONSENT_VERSION = (import.meta.env.VITE_WAITLIST_CONSENT_VERSION as string | undefined) ?? 'waitlist-v1';

type AccessStatus = { registration_open: boolean; waitlist_open: boolean; invite_only: boolean; reason: string; opened_at?: string | null };
type InviteInfo = { valid: boolean; program_name?: string; consent_version?: string; expires_at?: string; status?: string };

async function publicRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as T;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export default function PublicAccessApp({ session, onComplete }: { session: Session | null; onComplete: () => void }) {
  const params = useMemo(() => new URLSearchParams(window.location.hash.split('?')[1] ?? ''), []);
  const inviteToken = params.get('token') ?? '';
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [mode, setMode] = useState<'signin' | 'signup' | 'waitlist'>(inviteToken ? 'signup' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [referral, setReferral] = useState(params.get('ref') ?? '');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void publicRequest<AccessStatus>('/public/v10/status').then((value) => {
      setStatus(value);
      if (!inviteToken && !value.registration_open) setMode('signin');
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    if (inviteToken) void publicRequest<InviteInfo>('/public/v10/beta-invite', { method: 'POST', body: JSON.stringify({ token: inviteToken }) }).then(setInvite).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [inviteToken]);

  const submitAuth = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      if (mode === 'signin') {
        const result = await supabase.auth.signInWithPassword({ email, password });
        if (result.error) throw result.error;
        setMessage(inviteToken ? 'Signed in. Review and accept the beta terms.' : 'Signed in.');
        if (!inviteToken) onComplete();
      } else {
        if (!status?.registration_open && !inviteToken) throw new Error('Public registration is not open. Join the waitlist.');
        if (inviteToken && !invite?.valid) throw new Error('This beta invitation is invalid or expired.');
        const metadata = inviteToken ? { beta_invite_token_hash: await sha256(inviteToken) } : {};
        const result = await supabase.auth.signUp({ email, password, options: { data: metadata } });
        if (result.error) throw result.error;
        setMessage(result.data.session ? 'Account created. Accept the beta terms below.' : 'Check your inbox to confirm the account, then return to this invitation link.');
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const joinWaitlist = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      await publicRequest('/public/v10/waitlist', { method: 'POST', body: JSON.stringify({ email, consent_version: CONSENT_VERSION, source: params.get('utm_source') ?? 'direct', medium: params.get('utm_medium') ?? '', campaign: params.get('utm_campaign') ?? '', referral_code: referral }) });
      setMessage('You are on the waitlist. No account was created.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const acceptInvite = async () => {
    if (!inviteToken || !invite?.consent_version || !accepted) return;
    setBusy(true); setError('');
    try {
      await api('/api/v9/beta/invites/accept', { method: 'POST', body: JSON.stringify({ token: inviteToken, consent_version: invite.consent_version, confirmation: 'I ACCEPT' }) });
      window.location.hash = '';
      onComplete();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  if (inviteToken && session && invite?.valid) return <main className="public-access-shell"><section className="public-access-card"><div className="public-mark">BL</div><p className="public-kicker">Closed beta invitation</p><h1>{invite.program_name}</h1><p>You are signed in. Accept beta consent version <strong>{invite.consent_version}</strong> to join. The invitation expires {invite.expires_at ? new Date(invite.expires_at).toLocaleString() : 'soon'}.</p>{error && <div className="public-alert error">{error}</div>}<label className="consent-row"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /> I understand this is a beta, feedback may be requested, and normal export/deletion rights remain available.</label><button className="public-primary" disabled={busy || !accepted} onClick={() => void acceptInvite()}>Accept invitation</button><button className="public-link" onClick={() => void supabase.auth.signOut()}>Use another account</button></section></main>;

  const signupAllowed = Boolean(status?.registration_open || inviteToken);
  return <main className="public-access-shell"><section className="public-access-card"><div className="public-mark">BL</div><p className="public-kicker">Brandloom</p><h1>{inviteToken ? `Join ${invite?.program_name ?? 'the closed beta'}` : 'Build your brand operating system'}</h1><p>{inviteToken ? 'Create or sign in to an account to accept this invitation.' : status?.registration_open ? 'Public access is open.' : 'Public access is controlled while the launch gate is completed.'}</p>{error && <div className="public-alert error">{error}</div>}{message && <div className="public-alert success">{message}</div>}
    <div className="public-tabs"><button className={mode === 'signin' ? 'active' : ''} onClick={() => setMode('signin')}>Sign in</button>{signupAllowed && <button className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>Create account</button>}{status?.waitlist_open && !inviteToken && <button className={mode === 'waitlist' ? 'active' : ''} onClick={() => setMode('waitlist')}>Waitlist</button>}</div>
    {mode === 'waitlist' ? <form onSubmit={joinWaitlist}><label>Email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Referral code<input value={referral} onChange={(event) => setReferral(event.target.value.toUpperCase())} maxLength={20} /></label><p className="consent-copy">By joining, you consent to launch updates under version {CONSENT_VERSION}. You can unsubscribe later.</p><button className="public-primary" disabled={busy}>Join waitlist</button></form> : <form onSubmit={submitAuth}><label>Email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Password<input type="password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} /></label><button className="public-primary" disabled={busy}>{mode === 'signin' ? 'Sign in' : 'Create account'}</button></form>}
    <small className="public-status">{status?.reason ?? 'Checking access status…'}</small>
  </section></main>;
}
