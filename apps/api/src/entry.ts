import app from './index';
import phase2 from './phase2';
import phase3 from './phase3';
import phase4 from './phase4';
import phase4Public from './phase4Public';
import { dispatchDuePublications } from './publicationService';
import type { Env } from './types';

app.route('/', phase4Public);
app.route('/api', phase2);
app.route('/api', phase3);
app.route('/api', phase4);

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(dispatchDuePublications(env));
  },
} satisfies ExportedHandler<Env>;
