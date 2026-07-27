import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';

/**
 * Keyword auto-reply rules CRUD.
 *
 * Each rule fires when an inbound text message matches `keyword` (exact or
 * contains). The action is one of:
 *   - text             → reply with response_content as text
 *   - template         → reply by rendering templates.id (response_content)
 *   - add_tag          → attach tags.id to the friend (no message reply)
 *   - enroll_scenario  → enroll friend into scenarios.id (no message reply)
 *
 * The webhook side reads these rules; this file only manages them.
 */
const autoReplies = new Hono<Env>();

interface DbAutoReply {
  id: string;
  line_account_id: string | null;
  keyword: string;
  match_type: 'exact' | 'contains';
  response_type: string;
  response_content: string;
  is_active: number;
  created_at: string;
  updated_at: string | null;
}

function serialize(row: DbAutoReply) {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    keyword: row.keyword,
    matchType: row.match_type,
    responseType: row.response_type,
    responseContent: row.response_content,
    isActive: !!row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

autoReplies.get('/api/auto-replies', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const stmt = lineAccountId
      ? c.env.DB.prepare(`SELECT * FROM auto_replies WHERE line_account_id = ? OR line_account_id IS NULL ORDER BY created_at DESC`).bind(lineAccountId)
      : c.env.DB.prepare(`SELECT * FROM auto_replies ORDER BY created_at DESC`);
    const result = await stmt.all<DbAutoReply>();
    return c.json({ success: true, data: result.results.map(serialize) });
  } catch (err) {
    console.error('GET /api/auto-replies error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

autoReplies.post('/api/auto-replies', async (c) => {
  try {
    const body = await c.req.json<{
      keyword: string;
      matchType: 'exact' | 'contains';
      responseType: 'text' | 'template' | 'add_tag' | 'enroll_scenario';
      responseContent: string;
      isActive?: boolean;
    }>();
    if (!body.keyword || !body.matchType || !body.responseType || !body.responseContent) {
      return c.json({ success: false, error: 'keyword, matchType, responseType, responseContent are required' }, 400);
    }
    const lineAccountId = c.req.query('lineAccountId') ?? null;
    const id = crypto.randomUUID();
    const now = jstNow();
    await c.env.DB
      .prepare(`INSERT INTO auto_replies (id, line_account_id, keyword, match_type, response_type, response_content, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, lineAccountId, body.keyword, body.matchType, body.responseType, body.responseContent, body.isActive === false ? 0 : 1, now, now)
      .run();
    const row = await c.env.DB.prepare(`SELECT * FROM auto_replies WHERE id = ?`).bind(id).first<DbAutoReply>();
    return c.json({ success: true, data: row ? serialize(row) : null }, 201);
  } catch (err) {
    console.error('POST /api/auto-replies error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

autoReplies.put('/api/auto-replies/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      keyword?: string;
      matchType?: 'exact' | 'contains';
      responseType?: string;
      responseContent?: string;
      isActive?: boolean;
    }>();
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (body.keyword !== undefined) { sets.push('keyword = ?'); vals.push(body.keyword); }
    if (body.matchType !== undefined) { sets.push('match_type = ?'); vals.push(body.matchType); }
    if (body.responseType !== undefined) { sets.push('response_type = ?'); vals.push(body.responseType); }
    if (body.responseContent !== undefined) { sets.push('response_content = ?'); vals.push(body.responseContent); }
    if (body.isActive !== undefined) { sets.push('is_active = ?'); vals.push(body.isActive ? 1 : 0); }
    if (sets.length === 0) {
      const row = await c.env.DB.prepare(`SELECT * FROM auto_replies WHERE id = ?`).bind(id).first<DbAutoReply>();
      return c.json({ success: true, data: row ? serialize(row) : null });
    }
    sets.push('updated_at = ?');
    vals.push(jstNow());
    vals.push(id);
    await c.env.DB.prepare(`UPDATE auto_replies SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    const row = await c.env.DB.prepare(`SELECT * FROM auto_replies WHERE id = ?`).bind(id).first<DbAutoReply>();
    return c.json({ success: true, data: row ? serialize(row) : null });
  } catch (err) {
    console.error('PUT /api/auto-replies/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

autoReplies.delete('/api/auto-replies/:id', async (c) => {
  try {
    await c.env.DB.prepare(`DELETE FROM auto_replies WHERE id = ?`).bind(c.req.param('id')).run();
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/auto-replies/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { autoReplies };
