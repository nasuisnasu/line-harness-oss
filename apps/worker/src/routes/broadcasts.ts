import { Hono } from 'hono';
import {
  getBroadcasts,
  getBroadcastById,
  createBroadcast,
  updateBroadcast,
  deleteBroadcast,
  getLineAccountById,
  getFriendById,
} from '@line-crm/db';
import type { Broadcast as DbBroadcast, BroadcastMessageType, BroadcastTargetType } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { processBroadcastSend, buildMessage } from '../services/broadcast.js';
import { applyTrackingLinks } from '../services/step-delivery.js';
import { processSegmentSend } from '../services/segment-send.js';
import type { SegmentCondition } from '../services/segment-query.js';
import type { Env } from '../index.js';

const broadcasts = new Hono<Env>();

function serializeBroadcast(row: DbBroadcast) {
  let messages: { type: string; content: string }[] | null = null;
  if (row.messages_json) {
    try { messages = JSON.parse(row.messages_json); } catch { messages = null; }
  }
  let targetTagFilter: { include: string[]; exclude: string[] } | null = null;
  if (row.target_tag_filter_json) {
    try {
      const f = JSON.parse(row.target_tag_filter_json) as { include?: string[]; exclude?: string[] };
      targetTagFilter = { include: f.include ?? [], exclude: f.exclude ?? [] };
    } catch {
      targetTagFilter = null;
    }
  }
  return {
    id: row.id,
    title: row.title,
    messageType: row.message_type,
    messageContent: row.message_content,
    messages,
    targetType: row.target_type,
    targetTagId: row.target_tag_id,
    targetTagMode: row.target_tag_mode,
    targetTagFilter,
    status: row.status,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    totalCount: row.total_count,
    successCount: row.success_count,
    groupName: (row as DbBroadcast & { group_name?: string | null }).group_name ?? null,
    lineAccountId: (row as DbBroadcast & { line_account_id?: string | null }).line_account_id ?? null,
    createdAt: row.created_at,
  };
}

// Compute the friend audience for a broadcast definition without sending it.
// Used by the admin UI to show "X 人に配信予定" before the scheduled fire time.
async function computeAudience(
  db: D1Database,
  spec: {
    line_account_id: string | null;
    target_type: string;
    target_tag_id: string | null;
    target_tag_mode: string | null;
    target_tag_filter_json: string | null;
  },
  sampleSize = 10,
): Promise<{ count: number; sample: { id: string; displayName: string | null }[] }> {
  // Always restrict to followers / non-blocked friends.
  const accountClause = spec.line_account_id
    ? 'AND f.line_account_id = ?'
    : '';
  const accountBinds: string[] = spec.line_account_id ? [spec.line_account_id] : [];

  if (spec.target_type === 'all') {
    const countRow = await db
      .prepare(
        `SELECT COUNT(*) as count FROM friends f
         WHERE f.is_following = 1 AND f.is_blocked = 0 ${accountClause}`,
      )
      .bind(...accountBinds)
      .first<{ count: number }>();
    const sampleRows = await db
      .prepare(
        `SELECT f.id, f.display_name as displayName FROM friends f
         WHERE f.is_following = 1 AND f.is_blocked = 0 ${accountClause}
         ORDER BY f.created_at DESC LIMIT ${sampleSize}`,
      )
      .bind(...accountBinds)
      .all<{ id: string; displayName: string | null }>();
    return { count: countRow?.count ?? 0, sample: sampleRows.results ?? [] };
  }

  // Multi-tag filter (include / exclude)
  if (spec.target_tag_filter_json) {
    try {
      const f = JSON.parse(spec.target_tag_filter_json) as { include?: string[]; exclude?: string[] };
      const include = f.include ?? [];
      const exclude = f.exclude ?? [];
      const mode = (spec.target_tag_mode ?? 'AND') as 'AND' | 'OR';

      // include via JOIN with HAVING for AND, simple JOIN for OR
      const includeClause = include.length === 0
        ? ''
        : mode === 'AND'
          ? `AND f.id IN (
              SELECT friend_id FROM friend_tags
              WHERE tag_id IN (${include.map(() => '?').join(',')})
              GROUP BY friend_id HAVING COUNT(DISTINCT tag_id) = ${include.length}
            )`
          : `AND f.id IN (
              SELECT DISTINCT friend_id FROM friend_tags WHERE tag_id IN (${include.map(() => '?').join(',')})
            )`;
      const excludeClause = exclude.length === 0
        ? ''
        : `AND f.id NOT IN (
            SELECT DISTINCT friend_id FROM friend_tags WHERE tag_id IN (${exclude.map(() => '?').join(',')})
          )`;
      const where = `f.is_following = 1 AND f.is_blocked = 0 ${accountClause} ${includeClause} ${excludeClause}`;
      const binds = [...accountBinds, ...include, ...exclude];

      const countRow = await db
        .prepare(`SELECT COUNT(*) as count FROM friends f WHERE ${where}`)
        .bind(...binds)
        .first<{ count: number }>();
      const sampleRows = await db
        .prepare(
          `SELECT f.id, f.display_name as displayName FROM friends f
           WHERE ${where}
           ORDER BY f.created_at DESC LIMIT ${sampleSize}`,
        )
        .bind(...binds)
        .all<{ id: string; displayName: string | null }>();
      return { count: countRow?.count ?? 0, sample: sampleRows.results ?? [] };
    } catch {
      return { count: 0, sample: [] };
    }
  }

  // Legacy single tag
  if (spec.target_tag_id) {
    const where = `f.is_following = 1 AND f.is_blocked = 0 ${accountClause}
                   AND f.id IN (SELECT friend_id FROM friend_tags WHERE tag_id = ?)`;
    const binds = [...accountBinds, spec.target_tag_id];
    const countRow = await db
      .prepare(`SELECT COUNT(*) as count FROM friends f WHERE ${where}`)
      .bind(...binds)
      .first<{ count: number }>();
    const sampleRows = await db
      .prepare(
        `SELECT f.id, f.display_name as displayName FROM friends f
         WHERE ${where}
         ORDER BY f.created_at DESC LIMIT ${sampleSize}`,
      )
      .bind(...binds)
      .all<{ id: string; displayName: string | null }>();
    return { count: countRow?.count ?? 0, sample: sampleRows.results ?? [] };
  }

  return { count: 0, sample: [] };
}

// POST /api/broadcasts/test - send test message to the line account's test_friend_id
broadcasts.post('/api/broadcasts/test', async (c) => {
  try {
    const body = await c.req.json<{
      lineAccountId: string;
      messageType?: BroadcastMessageType;
      messageContent?: string;
      messages?: { type: string; content: string }[];
    }>();

    const hasMulti = Array.isArray(body.messages) && body.messages.length > 0;
    if (!body.lineAccountId || (!hasMulti && (!body.messageType || !body.messageContent))) {
      return c.json({ success: false, error: 'lineAccountId と messageType/messageContent もしくは messages[] が必要です' }, 400);
    }

    const account = await getLineAccountById(c.env.DB, body.lineAccountId);
    if (!account) {
      return c.json({ success: false, error: 'LINE account not found' }, 404);
    }
    if (!account.test_friend_id) {
      return c.json({ success: false, error: 'このLINEアカウントにはテスト送信先が設定されていません' }, 400);
    }

    const friend = await getFriendById(c.env.DB, account.test_friend_id);
    if (!friend) {
      return c.json({ success: false, error: 'テスト送信先の友達が見つかりません' }, 404);
    }

    const lineClient = new LineClient(account.channel_access_token);
    const tracking = c.env.TRACKING_BASE_URL ?? '';
    const messagesArr = hasMulti
      ? body.messages!.map((m) => buildMessage(m.type, applyTrackingLinks(m.content, tracking, friend.id)))
      : [buildMessage(body.messageType!, applyTrackingLinks(body.messageContent!, tracking, friend.id))];
    await lineClient.pushMessage(friend.line_user_id, messagesArr);

    return c.json({ success: true, data: { sentTo: friend.display_name ?? friend.line_user_id } });
  } catch (err) {
    console.error('POST /api/broadcasts/test error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }
});

// GET /api/broadcasts - list all
broadcasts.get('/api/broadcasts', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const items = await getBroadcasts(c.env.DB, lineAccountId);
    return c.json({ success: true, data: items.map(serializeBroadcast) });
  } catch (err) {
    console.error('GET /api/broadcasts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/broadcasts/:id/audience - preview "誰に・何人" before send
broadcasts.get('/api/broadcasts/:id/audience', async (c) => {
  try {
    const id = c.req.param('id');
    const broadcast = await getBroadcastById(c.env.DB, id);
    if (!broadcast) return c.json({ success: false, error: 'Broadcast not found' }, 404);
    const audience = await computeAudience(c.env.DB, {
      line_account_id: broadcast.line_account_id,
      target_type: broadcast.target_type,
      target_tag_id: broadcast.target_tag_id,
      target_tag_mode: broadcast.target_tag_mode,
      target_tag_filter_json: broadcast.target_tag_filter_json,
    });
    return c.json({ success: true, data: audience });
  } catch (err) {
    console.error('GET /api/broadcasts/:id/audience error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/broadcasts/:id - get single
broadcasts.get('/api/broadcasts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const broadcast = await getBroadcastById(c.env.DB, id);

    if (!broadcast) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    return c.json({ success: true, data: serializeBroadcast(broadcast) });
  } catch (err) {
    console.error('GET /api/broadcasts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/broadcasts - create
broadcasts.post('/api/broadcasts', async (c) => {
  try {
    const body = await c.req.json<{
      title: string;
      messageType: BroadcastMessageType;
      messageContent: string;
      messages?: { type: string; content: string }[];
      targetType: BroadcastTargetType;
      targetTagId?: string | null;
      targetTagMode?: 'include' | 'exclude';
      targetTagFilter?: { include?: string[]; exclude?: string[] } | null;
      scheduledAt?: string | null;
      groupName?: string | null;
    }>();

    const hasMulti = Array.isArray(body.messages) && body.messages.length > 0;
    if (!body.title || !body.targetType || (!hasMulti && (!body.messageType || !body.messageContent))) {
      return c.json(
        { success: false, error: 'title, messageType, messageContent (or messages[]), and targetType are required' },
        400,
      );
    }

    if (body.targetType === 'tag') {
      const hasFilter = body.targetTagFilter && (
        (body.targetTagFilter.include?.length ?? 0) > 0 ||
        (body.targetTagFilter.exclude?.length ?? 0) > 0
      );
      if (!body.targetTagId && !hasFilter) {
        return c.json(
          { success: false, error: 'targetTagId or targetTagFilter is required when targetType is "tag"' },
          400,
        );
      }
    }

    const lineAccountId = c.req.query('lineAccountId') ?? null;
    // For multi-message broadcasts, copy the first message into the legacy
    // type/content columns so DB-level integrity (NOT NULL) holds and
    // listing UIs can show a 1-line preview without parsing JSON.
    const firstMsg = hasMulti ? body.messages![0]! : null;
    const broadcast = await createBroadcast(c.env.DB, {
      title: body.title,
      messageType: hasMulti ? (firstMsg!.type as BroadcastMessageType) : body.messageType,
      messageContent: hasMulti ? firstMsg!.content : body.messageContent,
      messages: hasMulti ? body.messages : undefined,
      targetType: body.targetType,
      targetTagId: body.targetTagId ?? null,
      targetTagMode: body.targetTagMode ?? 'include',
      targetTagFilter: body.targetTagFilter ?? null,
      scheduledAt: body.scheduledAt ?? null,
      lineAccountId,
      groupName: body.groupName ?? null,
    });

    return c.json({ success: true, data: serializeBroadcast(broadcast) }, 201);
  } catch (err) {
    console.error('POST /api/broadcasts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/broadcasts/:id - update draft
broadcasts.put('/api/broadcasts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getBroadcastById(c.env.DB, id);

    if (!existing) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    if (existing.status !== 'draft' && existing.status !== 'scheduled') {
      return c.json({ success: false, error: 'Only draft or scheduled broadcasts can be updated' }, 400);
    }

    const body = await c.req.json<{
      title?: string;
      messageType?: BroadcastMessageType;
      messageContent?: string;
      messages?: { type: string; content: string }[];
      targetType?: BroadcastTargetType;
      targetTagId?: string | null;
      targetTagMode?: 'include' | 'exclude';
      targetTagFilter?: { include?: string[]; exclude?: string[] } | null;
      scheduledAt?: string | null;
      groupName?: string | null;
    }>();

    // Keep status in sync with scheduledAt changes
    let statusUpdate: 'draft' | 'scheduled' | undefined;
    if (body.scheduledAt !== undefined) {
      statusUpdate = body.scheduledAt ? 'scheduled' : 'draft';
    }

    let messagesJsonUpdate: string | null | undefined = undefined;
    if (body.messages !== undefined) {
      messagesJsonUpdate = body.messages.length > 0
        ? JSON.stringify(body.messages.slice(0, 5))
        : null;
    }

    let tagFilterJsonUpdate: string | null | undefined = undefined;
    if (body.targetTagFilter !== undefined) {
      tagFilterJsonUpdate = body.targetTagFilter
        ? JSON.stringify({
            include: body.targetTagFilter.include ?? [],
            exclude: body.targetTagFilter.exclude ?? [],
          })
        : null;
    }

    const updated = await updateBroadcast(c.env.DB, id, {
      title: body.title,
      message_type: body.messageType,
      message_content: body.messageContent,
      messages_json: messagesJsonUpdate,
      target_type: body.targetType,
      target_tag_id: body.targetTagId,
      target_tag_mode: body.targetTagMode,
      target_tag_filter_json: tagFilterJsonUpdate,
      scheduled_at: body.scheduledAt,
      group_name: body.groupName,
      ...(statusUpdate !== undefined ? { status: statusUpdate } : {}),
    });

    return c.json({ success: true, data: updated ? serializeBroadcast(updated) : null });
  } catch (err) {
    console.error('PUT /api/broadcasts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/broadcasts/:id - delete
broadcasts.delete('/api/broadcasts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await deleteBroadcast(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/broadcasts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/broadcasts/:id/send - send now
broadcasts.post('/api/broadcasts/:id/send', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getBroadcastById(c.env.DB, id);

    if (!existing) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    if (existing.status === 'sending' || existing.status === 'sent') {
      return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 400);
    }

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await processBroadcastSend(c.env.DB, lineClient, id, c.env.TRACKING_BASE_URL);

    const result = await getBroadcastById(c.env.DB, id);
    return c.json({ success: true, data: result ? serializeBroadcast(result) : null });
  } catch (err) {
    console.error('POST /api/broadcasts/:id/send error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/broadcasts/:id/send-segment - send to a filtered segment
broadcasts.post('/api/broadcasts/:id/send-segment', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getBroadcastById(c.env.DB, id);

    if (!existing) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    if (existing.status === 'sending' || existing.status === 'sent') {
      return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 400);
    }

    const body = await c.req.json<{ conditions: SegmentCondition }>();

    if (!body.conditions || !body.conditions.operator || !Array.isArray(body.conditions.rules)) {
      return c.json(
        { success: false, error: 'conditions with operator and rules array is required' },
        400,
      );
    }

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await processSegmentSend(c.env.DB, lineClient, id, body.conditions);

    const result = await getBroadcastById(c.env.DB, id);
    return c.json({ success: true, data: result ? serializeBroadcast(result) : null });
  } catch (err) {
    console.error('POST /api/broadcasts/:id/send-segment error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { broadcasts };
