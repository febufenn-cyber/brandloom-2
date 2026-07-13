import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import App from './App';
import OperationsApp from './OperationsApp';
import PublishingApp from './PublishingApp';
import CommercialApp from './CommercialApp';
import OptimizationApp from './OptimizationApp';
import ReliabilityApp from './ReliabilityApp';
import { supabase } from './lib/supabase';

export default function Root() {
  const [session, setSession] = useState<Session | null>(null);
  const [route, setRoute] = useState(window.location.hash.split('?')[0]);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const auth = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    const hash = () => setRoute(window.location.hash.split('?')[0]);
    window.addEventListener('hashchange', hash);
    return () => {
      auth.data.subscription.unsubscribe();
      window.removeEventListener('hashchange', hash);
    };
  }, []);

  if (route === '#operations') return <OperationsApp onBack={() => { window.location.hash = ''; }} />;
  if (route === '#publishing') return <PublishingApp onBack={() => { window.location.hash = ''; }} onOperations={() => { window.location.hash = 'operations'; }} />;
  if (route === '#commercial') return <CommercialApp onBack={() => { window.location.hash = ''; }} onOperations={() => { window.location.hash = 'operations'; }} onPublishing={() => { window.location.hash = 'publishing'; }} />;
  if (route === '#optimization') return <OptimizationApp onBack={() => { window.location.hash = ''; }} onOperations={() => { window.location.hash = 'operations'; }} onPublishing={() => { window.location.hash = 'publishing'; }} onCommercial={() => { window.location.hash = 'commercial'; }} />;
  if (route === '#reliability') return <ReliabilityApp onBack={() => { window.location.hash = ''; }} onOperations={() => { window.location.hash = 'operations'; }} onCommercial={() => { window.location.hash = 'commercial'; }} onOptimization={() => { window.location.hash = 'optimization'; }} />;
  return <>
    <App />
    {session && <div className="app-launches"><button className="operations-launch" onClick={() => { window.location.hash = 'operations'; }}>Open Operations</button><button className="publishing-launch" onClick={() => { window.location.hash = 'publishing'; }}>Open Publishing</button><button className="commercial-launch" onClick={() => { window.location.hash = 'commercial'; }}>Open Commercial</button><button className="optimization-launch" onClick={() => { window.location.hash = 'optimization'; }}>Open Optimization</button><button className="reliability-launch" onClick={() => { window.location.hash = 'reliability'; }}>Open Reliability</button></div>}
  </>;
}
