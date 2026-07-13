import { Hono } from 'hono';
import app from './index';
import phase2 from './phase2';
import phase3 from './phase3';
import phase4 from './phase4';
import phase4Public from './phase4Public';
import phase5 from './phase5';
import phase5Public from './phase5Public';
import phase6 from './phase6';
import { commercialGuard } from './commercialGuard';
import { commercialHousekeeping } from './commercialService';
import { optimizationHousekeeping } from './optimizationService';
import { dispatchDuePublications } from './publicationService';
import type { Env, Variables } from './types';

app.route('/api', phase2);
app.route('/api', phase3);
app.route('/api', phase4);
app.route('/api', phase5);
app.route('/api', phase6);

const root = new Hono<{ Bindings: Env; Variables: Variables }>();
root.route('/', phase4Public);
root.route('/', phase5Public);
root.use('/api/*', commercialGuard);
root.route('/', app);

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => root.fetch(request, env, ctx),
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(Promise.all([
      dispatchDuePublications(env),
      commercialHousekeeping(env),
      optimizationHousekeeping(env),
    ]));
  },
} satisfies ExportedHandler<Env>;
