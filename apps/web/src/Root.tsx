import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import App from './App';
import OperationsApp from './OperationsApp';
import { supabase } from './lib/supabase';

export default function Root() {
  const [session, setSession] = useState<Session | null>(null);
  const [route, setRoute] = useState(window.location.hash);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const auth = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    const hash = () => setRoute(window.location.hash);
    window.addEventListener('hashchange', hash);
    return () => {
      auth.data.subscription.unsubscribe();
      window.removeEventListener('hashchange', hash);
    };
  }, []);

  if (route === '#operations') return <OperationsApp onBack={() => { window.location.hash = ''; }} />;
  return <>
    <App />
    {session && <button className="operations-launch" onClick={() => { window.location.hash = 'operations'; }}>Open Operations</button>}
  </>;
}
