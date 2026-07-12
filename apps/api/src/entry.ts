import app from './index';
import phase2 from './phase2';
import phase3 from './phase3';

app.route('/api', phase2);
app.route('/api', phase3);

export default app;
