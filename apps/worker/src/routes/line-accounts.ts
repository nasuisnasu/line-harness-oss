import { Hono } from 'hono';
import {
  getLineAccounts,
  getLineAccountById,
  createLineAccount,
  updateLineAccount,
  deleteLineAccount,
} from '@line-crm/db';
import type { LineAccount as DbLineAccount } from '@line-crm/db';
import type { Env } from '../index.js';

const lineAccounts = new Hono<Env>();

function serializeLineAccount(row: DbLineAccount) {
  return {
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    isActive: Boolean(row.is_active),
    welcomeFallbackMessage: row.welcome_fallback_message ?? null,
    testFriendId: row.test_friend_id ?? null,
    pictureUrl: row.picture_url ?? null,
    profileSyncedAt: row.profile_synced_at ?? null,
    liffId: row.liff_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeLineAccountFull(row: DbLineAccount) {
  return {
    ...serializeLineAccount(row),
    channelAccessToken: row.channel_access_token,
    channelSecret: row.channel_secret,
  };
}

// GET /api/line-accounts - list all
lineAccounts.get('/api/line-accounts', async (c) => {
  try {
    const items = await getLineAccounts(c.env.DB);
    return c.json({ success: true, data: items.map(serializeLineAccount) });
  } catch (err) {
    console.error('GET /api/line-accounts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/line-accounts/:id - get single (includes secrets)
lineAccounts.get('/api/line-accounts/:id', async (c) => {
  try {
    const account = await getLineAccountById(c.env.DB, c.req.param('id'));
    if (!account) {
      return c.json({ success: false, error: 'LINE account not found' }, 404);
    }
    return c.json({ success: true, data: serializeLineAccountFull(account) });
  } catch (err) {
    console.error('GET /api/line-accounts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/line-accounts - create
lineAccounts.post('/api/line-accounts', async (c) => {
  try {
    const body = await c.req.json<{
      channelId: string;
      name: string;
      channelAccessToken: string;
      channelSecret: string;
    }>();

    if (!body.channelId || !body.name || !body.channelAccessToken || !body.channelSecret) {
      return c.json(
        { success: false, error: 'channelId, name, channelAccessToken, and channelSecret are required' },
        400,
      );
    }

    const account = await createLineAccount(c.env.DB, body);
    return c.json({ success: true, data: serializeLineAccountFull(account) }, 201);
  } catch (err) {
    console.error('POST /api/line-accounts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/line-accounts/:id - update
lineAccounts.put('/api/line-accounts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      name?: string;
      channelAccessToken?: string;
      channelSecret?: string;
      isActive?: boolean;
      welcomeFallbackMessage?: string | null;
      testFriendId?: string | null;
      liffId?: string | null;
    }>();

    const updated = await updateLineAccount(c.env.DB, id, {
      name: body.name,
      channel_access_token: body.channelAccessToken,
      channel_secret: body.channelSecret,
      is_active: body.isActive !== undefined ? (body.isActive ? 1 : 0) : undefined,
      welcome_fallback_message: body.welcomeFallbackMessage,
      test_friend_id: body.testFriendId,
      liff_id: body.liffId,
    });

    if (!updated) {
      return c.json({ success: false, error: 'LINE account not found' }, 404);
    }
    return c.json({ success: true, data: serializeLineAccountFull(updated) });
  } catch (err) {
    console.error('PUT /api/line-accounts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/line-accounts/:id - delete
lineAccounts.delete('/api/line-accounts/:id', async (c) => {
  try {
    await deleteLineAccount(c.env.DB, c.req.param('id'));
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/line-accounts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// 手動で LINE 側プロフィール（名前・アイコン）を即時同期
lineAccounts.post('/api/line-accounts/:id/sync-profile', async (c) => {
  try {
    const id = c.req.param('id');
    const { syncLineAccountProfiles } = await import('../services/line-account-profile-sync.js');
    const result = await syncLineAccountProfiles(c.env.DB, { force: true, accountId: id });
    if (result.errors.length > 0) {
      return c.json({ success: false, error: result.errors[0].error }, 500);
    }
    const { getLineAccountById } = await import('@line-crm/db');
    const acc = await getLineAccountById(c.env.DB, id);
    if (!acc) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serializeLineAccount(acc) });
  } catch (e) {
    return c.json({ success: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

export { lineAccounts };
