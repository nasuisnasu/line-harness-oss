import { Hono } from 'hono';
import { getTags, createTag, deleteTag, updateTag } from '@line-crm/db';
import type { Tag as DbTag } from '@line-crm/db';
import type { Env } from '../index.js';

const tags = new Hono<Env>();

function serializeTag(row: DbTag) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
  };
}

// GET /api/tags - list all tags
tags.get('/api/tags', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const items = await getTags(c.env.DB, lineAccountId);
    return c.json({ success: true, data: items.map(serializeTag) });
  } catch (err) {
    console.error('GET /api/tags error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/tags - create tag
tags.post('/api/tags', async (c) => {
  try {
    const body = await c.req.json<{ name: string; color?: string }>();
    const lineAccountId = c.req.query('lineAccountId') ?? null;

    if (!body.name) {
      return c.json({ success: false, error: 'name is required' }, 400);
    }

    const tag = await createTag(c.env.DB, {
      name: body.name,
      color: body.color,
      lineAccountId,
    });

    return c.json({ success: true, data: serializeTag(tag) }, 201);
  } catch (err) {
    console.error('POST /api/tags error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/tags/:id - update tag
tags.put('/api/tags/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ name?: string; color?: string }>();
    const tag = await updateTag(c.env.DB, id, body);
    if (!tag) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serializeTag(tag) });
  } catch (err) {
    console.error('PUT /api/tags/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/tags/:id - delete tag
tags.delete('/api/tags/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await deleteTag(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/tags/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { tags };
