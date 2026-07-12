import { supabase } from './supabase';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787';

function resolvePhase2Path(path: string, init: RequestInit) {
  if (path.startsWith('/api/v2/')) return path;
  const method = (init.method ?? 'GET').toUpperCase();
  const memoryAware = [
    method === 'POST' && /^\/api\/weekly-plans\/[^/]+\/(strategy|posts)\/generate$/.test(path),
    method === 'POST' && /^\/api\/content-items\/[^/]+\/regenerate$/.test(path),
    method === 'PATCH' && /^\/api\/content-items\/[^/]+$/.test(path),
  ].some(Boolean);
  return memoryAware ? path.replace('/api/', '/api/v2/') : path;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('You are not signed in.');
  const resolvedPath = resolvePhase2Path(path, init);
  const response = await fetch(`${API_URL}${resolvedPath}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
