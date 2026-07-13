import { Hono } from 'hono';
import { sha256 } from './commercial';
import type { Env, Variables } from './types';

const phase6Export = new Hono<{ Bindings: Env; Variables: Variables }>();
type Row = Record<string, any>;

phase6Export.get('/v6/brands/:brandId/export', async (c) => {
  const brandId = c.req.param('brandId');
  const supabase = c.get('supabase');
  const brandResult = await supabase.from('brands').select('id,workspace_id,name').eq('id', brandId).single();
  if (brandResult.error) throw brandResult.error;
  const tables: Array<[string, string]> = [
    ['metric_import_batches', 'brand_id'],
    ['content_performance_snapshots', 'brand_id'],
    ['optimization_reviews', 'brand_id'],
    ['optimization_recommendations', 'brand_id'],
    ['recommendation_evidence', 'brand_id'],
    ['optimization_decisions', 'brand_id'],
    ['brand_experiments', 'brand_id'],
    ['experiment_assignments', 'brand_id'],
    ['fatigue_signals', 'brand_id'],
    ['opportunity_signals', 'brand_id'],
    ['optimization_application_logs', 'brand_id'],
  ];
  const records: Record<string, Row[]> = {};
  for (const [table, column] of tables) {
    const result = await supabase.from(table).select('*').eq(column, brandId);
    if (result.error) throw result.error;
    records[table] = (result.data ?? []) as Row[];
  }
  const payload = {
    schema: 'brandloom.phase6.optimization-export.v1',
    exported_at: new Date().toISOString(),
    workspace_id: brandResult.data.workspace_id,
    brand: brandResult.data,
    records,
  };
  return c.json({ payload, checksum: await sha256(JSON.stringify(payload)) });
});

export default phase6Export;
