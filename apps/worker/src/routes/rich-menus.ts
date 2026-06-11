import { Hono } from 'hono';
import {
  getRichMenus,
  getRichMenuById,
  createRichMenuRecord,
  updateRichMenuRecord,
  deleteRichMenuRecord,
  clearOtherDefaults,
  clearOtherFriendAddMenus,
  parseRichMenuAreas,
  getLineAccountById,
  getFriendById,
} from '@line-crm/db';
import type { RichMenu, RichMenuArea, RichMenuSizeType } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../index.js';

const richMenus = new Hono<Env>();

const SIZE_DIMS: Record<RichMenuSizeType, { width: number; height: number }> = {
  full: { width: 2500, height: 1686 },
  compact: { width: 2500, height: 843 },
};

function serialize(row: RichMenu) {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    name: row.name,
    lineRichmenuId: row.line_richmenu_id,
    sizeType: row.size_type,
    chatBarText: row.chat_bar_text,
    selected: Boolean(row.selected),
    areas: parseRichMenuAreas(row),
    isDefault: Boolean(row.is_default),
    showOnFriendAdd: Boolean(row.show_on_friend_add),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLineRichMenuObject(row: RichMenu, areas: RichMenuArea[]) {
  return {
    size: SIZE_DIMS[row.size_type],
    selected: Boolean(row.selected),
    name: row.name,
    chatBarText: row.chat_bar_text,
    areas: areas.map((a) => ({ bounds: a.bounds, action: a.action })),
  };
}

// ─── List ────────────────────────────────────────────────────────────────
richMenus.get('/api/rich-menus', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const items = await getRichMenus(c.env.DB, lineAccountId);
    return c.json({ success: true, data: items.map(serialize) });
  } catch (err) {
    console.error('GET /api/rich-menus error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── Get single ─────────────────────────────────────────────────────────
richMenus.get('/api/rich-menus/:id', async (c) => {
  try {
    const item = await getRichMenuById(c.env.DB, c.req.param('id'));
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serialize(item) });
  } catch (err) {
    console.error('GET /api/rich-menus/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── Create (DB only, image upload separately via /publish) ─────────────
richMenus.post('/api/rich-menus', async (c) => {
  try {
    const body = await c.req.json<{
      lineAccountId: string;
      name: string;
      sizeType: RichMenuSizeType;
      chatBarText: string;
      selected?: boolean;
      areas: RichMenuArea[];
      isDefault?: boolean;
      showOnFriendAdd?: boolean;
    }>();
    if (!body.lineAccountId || !body.name || !body.sizeType) {
      return c.json({ success: false, error: 'lineAccountId, name, sizeType are required' }, 400);
    }
    const created = await createRichMenuRecord(c.env.DB, {
      lineAccountId: body.lineAccountId,
      name: body.name,
      sizeType: body.sizeType,
      chatBarText: body.chatBarText || 'メニュー',
      selected: body.selected !== false,
      areas: body.areas || [],
      isDefault: body.isDefault,
      showOnFriendAdd: body.showOnFriendAdd,
    });
    return c.json({ success: true, data: serialize(created) }, 201);
  } catch (err) {
    console.error('POST /api/rich-menus error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }
});

// ─── Update ─────────────────────────────────────────────────────────────
richMenus.put('/api/rich-menus/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getRichMenuById(c.env.DB, id);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);

    const body = await c.req.json<{
      name?: string;
      sizeType?: RichMenuSizeType;
      chatBarText?: string;
      selected?: boolean;
      areas?: RichMenuArea[];
    }>();

    // Persist DB changes first.
    const updated = await updateRichMenuRecord(c.env.DB, id, body);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);

    // If the menu was already published to LINE and a structural field
    // (areas / sizeType / chatBarText / selected) changed, re-publish so the
    // live menu reflects the new layout. Without this, edits to tap regions
    // looked saved in the admin but the LINE-side menu still served the old
    // bounds and the right half wouldn't respond.
    const structuralChange =
      body.areas !== undefined ||
      body.sizeType !== undefined ||
      body.chatBarText !== undefined ||
      body.selected !== undefined;
    if (existing.line_richmenu_id && structuralChange) {
      try {
        const account = await getLineAccountById(c.env.DB, updated.line_account_id);
        if (account) {
          const client = new LineClient(account.channel_access_token);
          // Pull the existing image off LINE so the operator doesn't have to
          // re-upload just to change tap regions.
          const { data, contentType } = await client.downloadRichMenuImage(existing.line_richmenu_id);
          // Drop the old menu and rebuild with the updated layout.
          try { await client.deleteRichMenu(existing.line_richmenu_id); } catch (e) { console.error('republish: pre-delete failed:', e); }
          const areas = parseRichMenuAreas(updated);
          const lineMenu = toLineRichMenuObject(updated, areas);
          const { richMenuId } = await client.createRichMenu(lineMenu as never);
          const ct: 'image/png' | 'image/jpeg' = contentType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
          await client.uploadRichMenuImage(richMenuId, data, ct);
          await updateRichMenuRecord(c.env.DB, id, { lineRichmenuId: richMenuId });
          // Restore default-menu binding if this entry was the active default.
          if (existing.is_default) {
            try { await client.setDefaultRichMenu(richMenuId); } catch (e) { console.error('republish: set-default failed:', e); }
          }
        }
      } catch (err) {
        console.error('republish on update failed:', err);
        return c.json({
          success: false,
          error: 'DBは更新しましたが、LINE側の再公開に失敗しました。画像を再アップロードして公開し直してください。',
        }, 500);
      }
    }

    const finalRow = await getRichMenuById(c.env.DB, id);
    return c.json({ success: true, data: finalRow ? serialize(finalRow) : null });
  } catch (err) {
    console.error('PUT /api/rich-menus/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── Delete ─────────────────────────────────────────────────────────────
richMenus.delete('/api/rich-menus/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const item = await getRichMenuById(c.env.DB, id);
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);

    if (item.line_richmenu_id) {
      try {
        const account = await getLineAccountById(c.env.DB, item.line_account_id);
        if (account) {
          const client = new LineClient(account.channel_access_token);
          await client.deleteRichMenu(item.line_richmenu_id);
        }
      } catch (e) {
        console.error('LINE deleteRichMenu failed:', e);
      }
    }

    await deleteRichMenuRecord(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/rich-menus/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── Publish: 画像アップ＋LINE作成 (multipart) ───────────────────────────
richMenus.post('/api/rich-menus/:id/publish', async (c) => {
  try {
    const id = c.req.param('id');
    const item = await getRichMenuById(c.env.DB, id);
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);

    const account = await getLineAccountById(c.env.DB, item.line_account_id);
    if (!account) return c.json({ success: false, error: 'LINE account not found' }, 404);

    const formData = await c.req.formData();
    const imageFile = formData.get('image');
    if (!(imageFile instanceof File)) {
      return c.json({ success: false, error: 'image file required (multipart)' }, 400);
    }
    const contentType: 'image/png' | 'image/jpeg' = imageFile.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const imageData = await imageFile.arrayBuffer();

    const client = new LineClient(account.channel_access_token);

    if (item.line_richmenu_id) {
      try { await client.deleteRichMenu(item.line_richmenu_id); } catch (e) { console.error('Pre-delete failed:', e); }
    }

    const areas = parseRichMenuAreas(item);
    const lineMenu = toLineRichMenuObject(item, areas);
    const { richMenuId } = await client.createRichMenu(lineMenu as never);
    await client.uploadRichMenuImage(richMenuId, imageData, contentType);
    await updateRichMenuRecord(c.env.DB, id, { lineRichmenuId: richMenuId });

    const updated = await getRichMenuById(c.env.DB, id);
    return c.json({ success: true, data: updated ? serialize(updated) : null });
  } catch (err) {
    console.error('POST /api/rich-menus/:id/publish error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }
});

// ─── Set as default ─────────────────────────────────────────────────────
richMenus.post('/api/rich-menus/:id/set-default', async (c) => {
  try {
    const id = c.req.param('id');
    const item = await getRichMenuById(c.env.DB, id);
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);
    if (!item.line_richmenu_id) return c.json({ success: false, error: 'リッチメニューがLINEに公開されていません' }, 400);

    const account = await getLineAccountById(c.env.DB, item.line_account_id);
    if (!account) return c.json({ success: false, error: 'LINE account not found' }, 404);

    const client = new LineClient(account.channel_access_token);
    await client.setDefaultRichMenu(item.line_richmenu_id);

    await updateRichMenuRecord(c.env.DB, id, { isDefault: true });
    await clearOtherDefaults(c.env.DB, item.line_account_id, id);

    return c.json({ success: true, data: serialize((await getRichMenuById(c.env.DB, id))!) });
  } catch (err) {
    console.error('POST /api/rich-menus/:id/set-default error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }
});

// ─── Set as friend-add menu ────────────────────────────────────────────
richMenus.post('/api/rich-menus/:id/set-friend-add', async (c) => {
  try {
    const id = c.req.param('id');
    const item = await getRichMenuById(c.env.DB, id);
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);

    await updateRichMenuRecord(c.env.DB, id, { showOnFriendAdd: true });
    await clearOtherFriendAddMenus(c.env.DB, item.line_account_id, id);

    return c.json({ success: true, data: serialize((await getRichMenuById(c.env.DB, id))!) });
  } catch (err) {
    console.error('POST /api/rich-menus/:id/set-friend-add error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── Image proxy (preview) ─────────────────────────────────────────────
richMenus.get('/api/rich-menus/:id/image', async (c) => {
  try {
    const item = await getRichMenuById(c.env.DB, c.req.param('id'));
    if (!item || !item.line_richmenu_id) return c.json({ success: false, error: 'Not published' }, 404);

    const account = await getLineAccountById(c.env.DB, item.line_account_id);
    if (!account) return c.json({ success: false, error: 'LINE account not found' }, 404);

    const client = new LineClient(account.channel_access_token);
    const { data, contentType } = await client.downloadRichMenuImage(item.line_richmenu_id);
    return new Response(data, {
      headers: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=3600' },
    });
  } catch (err) {
    console.error('GET /api/rich-menus/:id/image error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── Friend ↔ rich menu manual link/unlink ──────────────────────────────
richMenus.post('/api/friends/:friendId/rich-menu', async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const body = await c.req.json<{ richMenuId: string }>();
    if (!body.richMenuId) return c.json({ success: false, error: 'richMenuId is required' }, 400);

    const friend = await getFriendById(c.env.DB, friendId);
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    const item = await getRichMenuById(c.env.DB, body.richMenuId);
    if (!item || !item.line_richmenu_id) return c.json({ success: false, error: 'Rich menu not published' }, 400);

    const account = await getLineAccountById(c.env.DB, item.line_account_id);
    if (!account) return c.json({ success: false, error: 'LINE account not found' }, 404);

    const client = new LineClient(account.channel_access_token);
    await client.linkRichMenuToUser(friend.line_user_id, item.line_richmenu_id);

    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('POST /api/friends/:friendId/rich-menu error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }
});

richMenus.delete('/api/friends/:friendId/rich-menu', async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const friend = await getFriendById(c.env.DB, friendId);
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    // friend's account
    const accountId = friend.line_account_id;
    if (!accountId) return c.json({ success: false, error: 'Friend has no line_account_id' }, 400);
    const account = await getLineAccountById(c.env.DB, accountId);
    if (!account) return c.json({ success: false, error: 'LINE account not found' }, 404);

    const client = new LineClient(account.channel_access_token);
    await client.unlinkRichMenuFromUser(friend.line_user_id);

    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/friends/:friendId/rich-menu error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { richMenus };
