import { Hono } from 'hono';
import {
  getEntryRoutes,
  createEntryRoute,
  updateEntryRoute,
  deleteEntryRoute,
} from '@line-crm/db';
import type { EntryRoute } from '@line-crm/db';
import type { Env } from '../index.js';

const entryRoutes = new Hono<Env>();

function serialize(row: EntryRoute) {
  return {
    id: row.id,
    refCode: row.ref_code,
    name: row.name,
    tagId: row.tag_id,
    scenarioId: row.scenario_id,
    redirectUrl: row.redirect_url,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/entry-routes
entryRoutes.get('/api/entry-routes', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');

    // アカウントフィルター + 流入人数をJOINで取得
    const query = lineAccountId
      ? `SELECT er.*, COUNT(rt.id) as count
         FROM entry_routes er
         LEFT JOIN tags t ON er.tag_id = t.id
         LEFT JOIN ref_tracking rt ON er.ref_code = rt.ref_code
         WHERE t.line_account_id = ?
         GROUP BY er.id
         ORDER BY er.created_at DESC`
      : `SELECT er.*, COUNT(rt.id) as count
         FROM entry_routes er
         LEFT JOIN ref_tracking rt ON er.ref_code = rt.ref_code
         GROUP BY er.id
         ORDER BY er.created_at DESC`;

    const result = lineAccountId
      ? await c.env.DB.prepare(query).bind(lineAccountId).all<EntryRoute & { count: number }>()
      : await c.env.DB.prepare(query).all<EntryRoute & { count: number }>();

    const data = result.results.map(row => ({ ...serialize(row), count: row.count ?? 0 }));
    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/entry-routes error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/entry-routes
entryRoutes.post('/api/entry-routes', async (c) => {
  try {
    const body = await c.req.json<{
      refCode: string;
      name: string;
      tagId?: string | null;
      scenarioId?: string | null;
      redirectUrl?: string | null;
      isActive?: boolean;
    }>();
    if (!body.refCode || !body.name) {
      return c.json({ success: false, error: 'refCode and name are required' }, 400);
    }
    const item = await createEntryRoute(c.env.DB, {
      refCode: body.refCode,
      name: body.name,
      tagId: body.tagId ?? null,
      scenarioId: body.scenarioId ?? null,
      redirectUrl: body.redirectUrl ?? null,
      isActive: body.isActive !== false,
    });
    return c.json({ success: true, data: serialize(item) }, 201);
  } catch (err) {
    console.error('POST /api/entry-routes error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/entry-routes/:id
entryRoutes.put('/api/entry-routes/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<Partial<{
      refCode: string;
      name: string;
      tagId: string | null;
      scenarioId: string | null;
      redirectUrl: string | null;
      isActive: boolean;
    }>>();
    const updated = await updateEntryRoute(c.env.DB, id, {
      refCode: body.refCode,
      name: body.name,
      tagId: body.tagId,
      scenarioId: body.scenarioId,
      redirectUrl: body.redirectUrl,
      isActive: body.isActive,
    });
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serialize(updated) });
  } catch (err) {
    console.error('PUT /api/entry-routes/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/entry-routes/:id
entryRoutes.delete('/api/entry-routes/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await deleteEntryRoute(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/entry-routes/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { entryRoutes };
