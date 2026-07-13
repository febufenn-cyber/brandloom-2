import { Hono } from 'hono';
import app from './index';
import phase2 from './phase2';
import phase3 from './phase3';
import phase4 from './phase4';
import phase4Public from './phase4Public';
import phase5 from './phase5';
import phase5Public from './phase5Public';
import phase6 from './phase6';
import phase6Export from './phase6Export';
import phase7 from './phase7';
import phase7Public from './phase7Public';
import { commercialGuard } from './commercialGuard';
import { commercialHousekeeping } from './commercialService';
import { optimizationExperimentGuard } from './optimizationGuard';
import { optimizationHousekeeping } from './optimizationService';
import { dispatchDuePublications } from './publicationService';
import { reliabilityGuard } from './reliabilityGuard';
import { reliabilityHousekeeping } from './reliabilityService';
import type { Env, Variables } from './types';

app.route('/api', phase2);
app.route('/api', phase3);
app.route('/api', phase4);
app.route('/api', phase5);
app.use('/api/v6/experiments/*', optimizationExperimentGuard);
app.route('/api', phase6);
app.route('/api', phase6Export);
app.route('/api', phase7);

const root = new Hono<{ Bindings: Env; Variables: Variables }>();
root.route('/', phase4Public);
root.route('/', phase5Public);
root.route('/', phase7Public);
root.use('/api/*', reliabilityGuard);
root.use('/api/*', commercialGuard);
root.route('/', app);

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => root.fetch(request, env, ctx),
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(Promise.all([
      dispatchDuePublications(env),
      commercialHousekeeping(env),
      optimizationHousekeeping(env),
      reliabilityHousekeeping(env),
    ]));
  },
} satisfies ExportedHandler<Env>;
