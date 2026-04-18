import { Hono } from 'hono';
import {
  getFriends,
  getFriendById,
  getFriendCount,
  addTagToFriend,
  removeTagFromFriend,
  getFriendTags,
  getScenarios,
  enrollFriendInScenario,
  jstNow,
} from '@line-crm/db';
import type { Friend as DbFriend, Tag as DbTag } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import type { Env } from '../index.js';

const friends = new Hono<Env>();

/** Convert a D1 snake_case Friend row to the shared camelCase shape */
function serializeFriend(row: DbFriend) {
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    displayName: row.display_name,
    pictureUrl: row.picture_url,
    statusMessage: row.status_message,
    isFollowing: Boolean(row.is_following),
    metadata: JSON.parse(row.metadata || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Convert a D1 snake_case Tag row to the shared camelCase shape */
function serializeTag(row: DbTag) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
  };
}

// GET /api/friends - list with pagination
friends.get('/api/friends', async (c) => {
  try {
    const limit = Number(c.req.query('limit') ?? '50');
    const offset = Number(c.req.query('offset') ?? '0');
    const tagId = c.req.query('tagId');
    const lineAccountIdParam = c.req.query('lineAccountId');
    // undefined = no filter, string = filter by account
    const lineAccountId: string | undefined = lineAccountIdParam;

    const db = c.env.DB;

    // When filtering by tag, count only friends with that tag for accurate pagination
    const totalPromise = tagId
      ? db
          .prepare(
            lineAccountId !== undefined
              ? `SELECT COUNT(*) as count FROM friends f
                 INNER JOIN friend_tags ft ON ft.friend_id = f.id
                 WHERE ft.tag_id = ? AND f.line_account_id = ?`
              : `SELECT COUNT(*) as count FROM friends f
                 INNER JOIN friend_tags ft ON ft.friend_id = f.id
                 WHERE ft.tag_id = ?`,
          )
          .bind(...(lineAccountId !== undefined ? [tagId, lineAccountId] : [tagId]))
          .first<{ count: number }>()
          .then((row) => row?.count ?? 0)
      : getFriendCount(db, lineAccountId);

    const [items, total] = await Promise.all([
      getFriends(db, { limit, offset, tagId, lineAccountId }),
      totalPromise,
    ]);

    // Fetch tags and active scenarios for each friend in parallel
    const itemsWithTags = await Promise.all(
      items.map(async (friend) => {
        const [tags, activeScenarios] = await Promise.all([
          getFriendTags(db, friend.id),
          db.prepare(
            `SELECT s.id, s.name FROM friend_scenarios fs
             JOIN scenarios s ON s.id = fs.scenario_id
             WHERE fs.friend_id = ? AND fs.status = 'active'`
          ).bind(friend.id).all<{ id: string; name: string }>(),
        ]);
        return {
          ...serializeFriend(friend),
          tags: tags.map(serializeTag),
          activeScenarios: activeScenarios.results,
        };
      }),
    );

    return c.json({
      success: true,
      data: {
        items: itemsWithTags,
        total,
        page: Math.floor(offset / limit) + 1,
        limit,
        hasNextPage: offset + limit < total,
      },
    });
  } catch (err) {
    console.error('GET /api/friends error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/count - friend count (must be before /:id)
friends.get('/api/friends/count', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const count = await getFriendCount(c.env.DB, lineAccountId);
    return c.json({ success: true, data: { count } });
  } catch (err) {
    console.error('GET /api/friends/count error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/:id - get single friend with tags
friends.get('/api/friends/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const db = c.env.DB;

    const [friend, tags] = await Promise.all([
      getFriendById(db, id),
      getFriendTags(db, id),
    ]);

    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    return c.json({
      success: true,
      data: {
        ...serializeFriend(friend),
        tags: tags.map(serializeTag),
      },
    });
  } catch (err) {
    console.error('GET /api/friends/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/:id/scenarios - scenario enrollment history with step details
friends.get('/api/friends/:id/scenarios', async (c) => {
  try {
    const friendId = c.req.param('id');
    const db = c.env.DB;

    const rows = await db.prepare(`
      SELECT
        fs.id, fs.status, fs.current_step_order, fs.started_at, fs.next_delivery_at,
        s.id as scenario_id, s.name as scenario_name,
        ss.step_order, ss.message_type, ss.message_content, ss.delay_minutes
      FROM friend_scenarios fs
      JOIN scenarios s ON s.id = fs.scenario_id
      LEFT JOIN scenario_steps ss ON ss.scenario_id = fs.scenario_id
      WHERE fs.friend_id = ?
      ORDER BY fs.started_at DESC, ss.step_order ASC
    `).bind(friendId).all<{
      id: string; status: string; current_step_order: number; started_at: string; next_delivery_at: string | null;
      scenario_id: string; scenario_name: string;
      step_order: number | null; message_type: string | null; message_content: string | null; delay_minutes: number | null;
    }>();

    // Group steps under each friend_scenario
    const map = new Map<string, {
      id: string; scenarioId: string; scenarioName: string;
      status: string; currentStepOrder: number; startedAt: string; nextDeliveryAt: string | null;
      steps: { stepOrder: number; messageType: string; messageContent: string; delayMinutes: number; sent: boolean }[];
    }>();
    for (const row of rows.results) {
      if (!map.has(row.id)) {
        map.set(row.id, {
          id: row.id, scenarioId: row.scenario_id, scenarioName: row.scenario_name,
          status: row.status, currentStepOrder: row.current_step_order,
          startedAt: row.started_at, nextDeliveryAt: row.next_delivery_at,
          steps: [],
        });
      }
      if (row.step_order !== null) {
        map.get(row.id)!.steps.push({
          stepOrder: row.step_order,
          messageType: row.message_type ?? 'text',
          messageContent: row.message_content ?? '',
          delayMinutes: row.delay_minutes ?? 0,
          sent: row.step_order < row.current_step_order,
        });
      }
    }

    return c.json({ success: true, data: Array.from(map.values()) });
  } catch (err) {
    console.error('GET /api/friends/:id/scenarios error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/:id/tags - add tag
friends.post('/api/friends/:id/tags', async (c) => {
  try {
    const friendId = c.req.param('id');
    const body = await c.req.json<{ tagId: string }>();

    if (!body.tagId) {
      return c.json({ success: false, error: 'tagId is required' }, 400);
    }

    const db = c.env.DB;
    await addTagToFriend(db, friendId, body.tagId);

    // Enroll in tag_added scenarios that match this tag
    const allScenarios = await getScenarios(db);
    for (const scenario of allScenarios) {
      if (scenario.trigger_type === 'tag_added' && scenario.is_active && scenario.trigger_tag_id === body.tagId) {
        const existing = await db
          .prepare(`SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`)
          .bind(friendId, scenario.id)
          .first();
        if (!existing) {
          await enrollFriendInScenario(db, friendId, scenario.id);
        }
      }
    }

    // イベントバス発火: tag_change
    await fireEvent(db, 'tag_change', { friendId, eventData: { tagId: body.tagId, action: 'add' } });

    return c.json({ success: true, data: null }, 201);
  } catch (err) {
    console.error('POST /api/friends/:id/tags error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/friends/:id/tags/:tagId - remove tag
friends.delete('/api/friends/:id/tags/:tagId', async (c) => {
  try {
    const friendId = c.req.param('id');
    const tagId = c.req.param('tagId');

    await removeTagFromFriend(c.env.DB, friendId, tagId);

    // イベントバス発火: tag_change
    await fireEvent(c.env.DB, 'tag_change', { friendId, eventData: { tagId, action: 'remove' } });

    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/friends/:id/tags/:tagId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/friends/:id/metadata - merge metadata fields
friends.put('/api/friends/:id/metadata', async (c) => {
  try {
    const friendId = c.req.param('id');
    const db = c.env.DB;

    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const body = await c.req.json<Record<string, unknown>>();
    const existing = JSON.parse(friend.metadata || '{}');
    const merged = { ...existing, ...body };
    const now = jstNow();

    await db
      .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(merged), now, friendId)
      .run();

    const updated = await getFriendById(db, friendId);
    const tags = await getFriendTags(db, friendId);

    return c.json({
      success: true,
      data: {
        ...serializeFriend(updated!),
        tags: tags.map(serializeTag),
      },
    });
  } catch (err) {
    console.error('PUT /api/friends/:id/metadata error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/:id/messages - send message to friend
friends.post('/api/friends/:id/messages', async (c) => {
  try {
    const friendId = c.req.param('id');
    const body = await c.req.json<{
      messageType?: string;
      content: string;
    }>();

    if (!body.content) {
      return c.json({ success: false, error: 'content is required' }, 400);
    }

    const db = c.env.DB;
    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const { LineClient } = await import('@line-crm/line-sdk');
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    const messageType = body.messageType ?? 'text';

    if (messageType === 'text') {
      await lineClient.pushMessage(friend.line_user_id, [{ type: 'text', text: body.content }]);
    } else if (messageType === 'flex') {
      const contents = JSON.parse(body.content);
      await lineClient.pushMessage(friend.line_user_id, [{ type: 'flex', altText: 'Message', contents }]);
    } else if (messageType === 'image') {
      const parsed = JSON.parse(body.content);
      await lineClient.pushMessage(friend.line_user_id, [{
        type: 'image',
        originalContentUrl: parsed.originalContentUrl,
        previewImageUrl: parsed.previewImageUrl,
      }]);
    }

    // Log outgoing message
    const logId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, ?)`,
      )
      .bind(logId, friend.id, messageType, body.content, jstNow())
      .run();

    return c.json({ success: true, data: { messageId: logId } });
  } catch (err) {
    console.error('POST /api/friends/:id/messages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { friends };
