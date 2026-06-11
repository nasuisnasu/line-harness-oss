import { Hono } from 'hono';
import {
  getEntryRoutes,
  createEntryRoute,
  updateEntryRoute,
  deleteEntryRoute,
  getEntryRouteTagIds,
} from '@line-crm/db';
import type { EntryRoute } from '@line-crm/db';
import type { Env } from '../index.js';

const entryRoutes = new Hono<Env>();

function serialize(row: EntryRoute & { line_account_id?: string | null }, tagIds: string[] = []) {
  return {
    id: row.id,
    refCode: row.ref_code,
    name: row.name,
    tagId: row.tag_id,
    tagIds,
    scenarioId: row.scenario_id,
    lineAccountId: row.line_account_id ?? null,
    redirectUrl: row.redirect_url,
    isActive: Boolean(row.is_active),
    groupName: row.group_name ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/entry-routes
entryRoutes.get('/api/entry-routes', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');

    // アカウントフィルター + 流入人数 + 累計売上。
    // 売上は subquery で出す（ref_tracking + payments を直接JOINすると
    // ref_tracking複数行 × payments複数行で金額が膨れるため）。
    const query = lineAccountId
      ? `SELECT er.*,
                COUNT(DISTINCT rt.friend_id) as count,
                COALESCE((
                  SELECT SUM(fp.amount)
                  FROM friend_payments fp
                  WHERE fp.friend_id IN (
                    SELECT DISTINCT friend_id FROM ref_tracking WHERE ref_code = er.ref_code
                  )
                ), 0) as totalRevenue
         FROM entry_routes er
         LEFT JOIN ref_tracking rt ON er.ref_code = rt.ref_code
         WHERE er.line_account_id = ?
         GROUP BY er.id
         ORDER BY er.created_at DESC`
      : `SELECT er.*,
                COUNT(DISTINCT rt.friend_id) as count,
                COALESCE((
                  SELECT SUM(fp.amount)
                  FROM friend_payments fp
                  WHERE fp.friend_id IN (
                    SELECT DISTINCT friend_id FROM ref_tracking WHERE ref_code = er.ref_code
                  )
                ), 0) as totalRevenue
         FROM entry_routes er
         LEFT JOIN ref_tracking rt ON er.ref_code = rt.ref_code
         GROUP BY er.id
         ORDER BY er.created_at DESC`;

    const result = lineAccountId
      ? await c.env.DB.prepare(query).bind(lineAccountId).all<EntryRoute & { count: number; totalRevenue: number }>()
      : await c.env.DB.prepare(query).all<EntryRoute & { count: number; totalRevenue: number }>();

    // tagIds を全件分まとめて取得
    const dataWithTags = await Promise.all(
      result.results.map(async (row) => {
        const tagIds = await getEntryRouteTagIds(c.env.DB, row);
        return {
          ...serialize(row, tagIds),
          count: row.count ?? 0,
          totalRevenue: row.totalRevenue ?? 0,
        };
      }),
    );
    return c.json({ success: true, data: dataWithTags });
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
      tagIds?: string[];
      scenarioId?: string | null;
      redirectUrl?: string | null;
      isActive?: boolean;
      lineAccountId?: string | null;
      groupName?: string | null;
    }>();
    if (!body.name) {
      return c.json({ success: false, error: 'name is required' }, 400);
    }
    // refCode は省略可。空のときは衝突しにくい短いコードを自動採番する。
    // 既存運用と被らない用に prefix を付け、ユニーク性は再試行ループで担保。
    let refCode = (body.refCode ?? '').trim();
    if (!refCode) {
      for (let i = 0; i < 5; i++) {
        const candidate = `r-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
        const existing = await c.env.DB
          .prepare(`SELECT id FROM entry_routes WHERE ref_code = ?`)
          .bind(candidate)
          .first<{ id: string }>();
        if (!existing) {
          refCode = candidate;
          break;
        }
      }
      if (!refCode) {
        return c.json({ success: false, error: 'failed to allocate refCode' }, 500);
      }
    }
    const item = await createEntryRoute(c.env.DB, {
      refCode,
      name: body.name,
      tagId: body.tagId ?? null,
      tagIds: body.tagIds,
      scenarioId: body.scenarioId ?? null,
      redirectUrl: body.redirectUrl ?? null,
      isActive: body.isActive !== false,
      lineAccountId: body.lineAccountId ?? null,
      groupName: body.groupName ?? null,
    });
    const tagIds = await getEntryRouteTagIds(c.env.DB, item);
    return c.json({ success: true, data: serialize(item, tagIds) }, 201);
  } catch (err) {
    console.error('POST /api/entry-routes error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/entry-routes/groups/rename — bulk rename a group label across
// all rows. The frontend uses this so an operator can rename "Thread" →
// "Threads" without opening every entry-route.
entryRoutes.post('/api/entry-routes/groups/rename', async (c) => {
  try {
    const body = await c.req.json<{ from: string; to: string | null }>();
    if (!body.from) {
      return c.json({ success: false, error: 'from is required' }, 400);
    }
    const target = body.to === null || body.to === undefined ? null : String(body.to).trim() || null;
    const res = await c.env.DB
      .prepare(`UPDATE entry_routes SET group_name = ? WHERE group_name = ?`)
      .bind(target, body.from)
      .run();
    const changes = (res as { meta?: { changes?: number } }).meta?.changes ?? 0;
    return c.json({ success: true, data: { changes } });
  } catch (err) {
    console.error('POST /api/entry-routes/groups/rename error:', err);
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
      tagIds: string[];
      scenarioId: string | null;
      redirectUrl: string | null;
      isActive: boolean;
      groupName: string | null;
    }>>();
    const updated = await updateEntryRoute(c.env.DB, id, {
      refCode: body.refCode,
      name: body.name,
      tagId: body.tagId,
      tagIds: body.tagIds,
      scenarioId: body.scenarioId,
      redirectUrl: body.redirectUrl,
      isActive: body.isActive,
      groupName: body.groupName,
    });
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    const tagIds = await getEntryRouteTagIds(c.env.DB, updated);
    return c.json({ success: true, data: serialize(updated, tagIds) });
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
