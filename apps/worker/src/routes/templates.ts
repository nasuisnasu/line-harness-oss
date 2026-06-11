import { Hono } from 'hono';
import {
  getTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getLineAccountById,
  getFriendById,
} from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { buildMessage, applyTrackingLinks } from '../services/step-delivery.js';
import type { Env } from '../index.js';

const templates = new Hono<Env>();

templates.get('/api/templates', async (c) => {
  try {
    const category = c.req.query('category') ?? undefined;
    const lineAccountId = c.req.query('lineAccountId') ?? undefined;
    const items = await getTemplates(c.env.DB, category, lineAccountId);
    return c.json({
      success: true,
      data: items.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        messageType: t.message_type,
        messageContent: t.message_content,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/templates error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.get('/api/templates/:id', async (c) => {
  try {
    const item = await getTemplateById(c.env.DB, c.req.param('id'));
    if (!item) return c.json({ success: false, error: 'Template not found' }, 404);
    return c.json({
      success: true,
      data: { id: item.id, name: item.name, category: item.category, messageType: item.message_type, messageContent: item.message_content, createdAt: item.created_at, updatedAt: item.updated_at },
    });
  } catch (err) {
    console.error('GET /api/templates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.post('/api/templates', async (c) => {
  try {
    const body = await c.req.json<{ name: string; category?: string; messageType: string; messageContent: string }>();
    if (!body.name || !body.messageType || !body.messageContent) {
      return c.json({ success: false, error: 'name, messageType, messageContent are required' }, 400);
    }
    const lineAccountId = c.req.query('lineAccountId') ?? null;
    const item = await createTemplate(c.env.DB, { ...body, lineAccountId });
    return c.json({ success: true, data: { id: item.id, name: item.name, category: item.category, messageType: item.message_type, createdAt: item.created_at } }, 201);
  } catch (err) {
    console.error('POST /api/templates error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.put('/api/templates/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    await updateTemplate(c.env.DB, id, body);
    const updated = await getTemplateById(c.env.DB, id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: { id: updated.id, name: updated.name, category: updated.category, messageType: updated.message_type, messageContent: updated.message_content },
    });
  } catch (err) {
    console.error('PUT /api/templates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.post('/api/templates/:id/test-send', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ lineAccountId: string }>();
    if (!body.lineAccountId) {
      return c.json({ success: false, error: 'lineAccountId is required' }, 400);
    }

    const tpl = await getTemplateById(c.env.DB, id);
    if (!tpl) return c.json({ success: false, error: 'Template not found' }, 404);

    const account = await getLineAccountById(c.env.DB, body.lineAccountId);
    if (!account) return c.json({ success: false, error: 'LINE account not found' }, 404);
    if (!account.test_friend_id) {
      return c.json({ success: false, error: 'このLINEアカウントにはテスト送信先が設定されていません' }, 400);
    }
    const friend = await getFriendById(c.env.DB, account.test_friend_id);
    if (!friend) return c.json({ success: false, error: 'テスト送信先の友達が見つかりません' }, 404);

    const personalContent = c.env.TRACKING_BASE_URL
      ? applyTrackingLinks(tpl.message_content, c.env.TRACKING_BASE_URL, friend.id)
      : tpl.message_content;
    const message = buildMessage(tpl.message_type, personalContent);
    const client = new LineClient(account.channel_access_token);
    await client.pushMessage(friend.line_user_id, [message]);

    return c.json({ success: true, data: { sentTo: friend.display_name ?? friend.line_user_id } });
  } catch (err) {
    console.error('POST /api/templates/:id/test-send error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }
});

templates.delete('/api/templates/:id', async (c) => {
  try {
    await deleteTemplate(c.env.DB, c.req.param('id'));
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/templates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { templates };
