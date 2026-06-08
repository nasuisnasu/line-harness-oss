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
  updateFriendBlocked,
  getLineAccountById,
  jstNow,
} from '@line-crm/db';
import type { Friend as DbFriend, Tag as DbTag } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { notifyScenarioEnrolled } from '../services/discord-notify.js';
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
    isBlocked: Boolean(row.is_blocked),
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
          getFriendTags(db, friend.id, lineAccountId),
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

// GET /api/friends/daily-stats - 日別の新規追加・ブロック数・累計有効友達数
friends.get('/api/friends/daily-stats', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId') ?? null;
    const days = Math.min(Math.max(Number(c.req.query('days') ?? '14'), 1), 90);
    const eventId = c.req.query('eventId') ?? null; // 申込み数を特定イベントに絞る（戦略会議など）

    // クエリ用 WHERE句（lineAccountIdの絞り込み）
    const accountFilter = lineAccountId ? 'AND line_account_id = ?' : '';
    const accountBind = lineAccountId ? [lineAccountId] : [];

    // 日別の新規追加
    const addedRows = await c.env.DB
      .prepare(
        `SELECT substr(created_at, 1, 10) as day, COUNT(*) as added
         FROM friends WHERE 1=1 ${accountFilter}
         GROUP BY substr(created_at, 1, 10)`,
      )
      .bind(...accountBind)
      .all<{ day: string; added: number }>();

    // 日別のブロック (is_following=0 になった日 = updated_at の日付)
    const blockedRows = await c.env.DB
      .prepare(
        `SELECT substr(updated_at, 1, 10) as day, COUNT(*) as blocked
         FROM friends WHERE is_following = 0 ${accountFilter}
         GROUP BY substr(updated_at, 1, 10)`,
      )
      .bind(...accountBind)
      .all<{ day: string; blocked: number }>();

    // 日別の申込み数（イベント予約 = 戦略会議など）。申込み発生日(created_at)で集計。
    const bookingConditions: string[] = [`b.status = 'confirmed'`];
    const bookingBind: unknown[] = [];
    if (lineAccountId) { bookingConditions.push('e.line_account_id = ?'); bookingBind.push(lineAccountId); }
    if (eventId) { bookingConditions.push('b.app_event_id = ?'); bookingBind.push(eventId); }
    const bookingRows = await c.env.DB
      .prepare(
        `SELECT substr(b.created_at, 1, 10) as day, COUNT(*) as bookings
         FROM calendar_bookings b
         JOIN events e ON e.id = b.app_event_id
         WHERE ${bookingConditions.join(' AND ')}
         GROUP BY substr(b.created_at, 1, 10)`,
      )
      .bind(...bookingBind)
      .all<{ day: string; bookings: number }>();

    const addedMap = new Map(addedRows.results.map((r) => [r.day, r.added]));
    const blockedMap = new Map(blockedRows.results.map((r) => [r.day, r.blocked]));
    const bookingsMap = new Map(bookingRows.results.map((r) => [r.day, r.bookings]));

    // 過去 `days` 日分の日付リスト（JST基準で本日まで）
    const result: { date: string; added: number; blocked: number; cumulative: number; bookings: number }[] = [];
    const dateList: string[] = [];
    const today = new Date(Date.now() + 9 * 60 * 60_000); // JST
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dateList.push(d.toISOString().slice(0, 10));
    }

    // 累計のために、対象期間より前の合計（追加-ブロック）を起点として用意
    let cumulative = 0;
    const startDay = dateList[0];
    for (const [day, count] of addedMap) {
      if (day < startDay) cumulative += count;
    }
    for (const [day, count] of blockedMap) {
      if (day < startDay) cumulative -= count;
    }

    for (const date of dateList) {
      const added = addedMap.get(date) ?? 0;
      const blocked = blockedMap.get(date) ?? 0;
      const bookings = bookingsMap.get(date) ?? 0;
      cumulative += added - blocked;
      result.push({ date, added, blocked, cumulative, bookings });
    }

    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('GET /api/friends/daily-stats error:', err);
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

    // Resolve entry route via friend's ref_code (set when they joined via tracked URL).
    let entryRoute: { id: string; name: string; refCode: string } | null = null;
    const refCode = (friend as DbFriend & { ref_code?: string | null }).ref_code;
    if (refCode) {
      const er = await db
        .prepare('SELECT id, name, ref_code FROM entry_routes WHERE ref_code = ? LIMIT 1')
        .bind(refCode)
        .first<{ id: string; name: string; ref_code: string }>();
      if (er) entryRoute = { id: er.id, name: er.name, refCode: er.ref_code };
    }

    return c.json({
      success: true,
      data: {
        ...serializeFriend(friend),
        tags: tags.map(serializeTag),
        entryRoute,
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
        ss.step_order, ss.message_type, ss.message_content, ss.delay_minutes,
        ss.delay_mode, ss.delay_days, ss.delay_time, ss.delay_at
      FROM friend_scenarios fs
      JOIN scenarios s ON s.id = fs.scenario_id
      LEFT JOIN scenario_steps ss ON ss.scenario_id = fs.scenario_id
      WHERE fs.friend_id = ?
      ORDER BY fs.started_at DESC, ss.step_order ASC
    `).bind(friendId).all<{
      id: string; status: string; current_step_order: number; started_at: string; next_delivery_at: string | null;
      scenario_id: string; scenario_name: string;
      step_order: number | null; message_type: string | null; message_content: string | null; delay_minutes: number | null;
      delay_mode: string | null; delay_days: number | null; delay_time: string | null; delay_at: string | null;
    }>();

    // Group steps under each friend_scenario
    const map = new Map<string, {
      id: string; scenarioId: string; scenarioName: string;
      status: string; currentStepOrder: number; startedAt: string; nextDeliveryAt: string | null;
      steps: {
        stepOrder: number; messageType: string; messageContent: string;
        delayMinutes: number; delayMode: string; delayDays: number | null; delayTime: string | null; delayAt: string | null;
        sent: boolean;
      }[];
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
          delayMode: row.delay_mode ?? 'relative',
          delayDays: row.delay_days,
          delayTime: row.delay_time,
          delayAt: row.delay_at,
          sent: row.step_order <= row.current_step_order,
        });
      }
    }

    return c.json({ success: true, data: Array.from(map.values()) });
  } catch (err) {
    console.error('GET /api/friends/:id/scenarios error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/:id/link-clicks - tracked link clicks by this friend
friends.get('/api/friends/:id/link-clicks', async (c) => {
  try {
    const friendId = c.req.param('id');
    const result = await c.env.DB
      .prepare(
        `SELECT lc.tracked_link_id as trackedLinkId, lc.clicked_at as clickedAt, tl.name as linkName
         FROM link_clicks lc
         LEFT JOIN tracked_links tl ON tl.id = lc.tracked_link_id
         WHERE lc.friend_id = ?
         ORDER BY lc.clicked_at ASC`,
      )
      .bind(friendId)
      .all<{ trackedLinkId: string; clickedAt: string; linkName: string | null }>();
    return c.json({ success: true, data: result.results });
  } catch (err) {
    console.error('GET /api/friends/:id/link-clicks error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/:id/bookings - calendar bookings for this friend
friends.get('/api/friends/:id/bookings', async (c) => {
  try {
    const friendId = c.req.param('id');
    const result = await c.env.DB
      .prepare(
        `SELECT b.id, b.title, b.start_at as startAt, b.end_at as endAt, b.status,
                b.app_event_id as appEventId, e.name as eventName
         FROM calendar_bookings b
         LEFT JOIN events e ON e.id = b.app_event_id
         WHERE b.friend_id = ?
         ORDER BY b.start_at DESC`,
      )
      .bind(friendId)
      .all<{
        id: string; title: string; startAt: string; endAt: string;
        status: string; appEventId: string | null; eventName: string | null;
      }>();
    return c.json({ success: true, data: result.results ?? [] });
  } catch (err) {
    console.error('GET /api/friends/:id/bookings error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/:id/payments - payment history for this friend
friends.get('/api/friends/:id/payments', async (c) => {
  try {
    const friendId = c.req.param('id');
    const result = await c.env.DB
      .prepare(
        `SELECT id, amount, note, paid_at as paidAt, created_at as createdAt
         FROM friend_payments
         WHERE friend_id = ?
         ORDER BY paid_at DESC`,
      )
      .bind(friendId)
      .all<{ id: string; amount: number; note: string | null; paidAt: string; createdAt: string }>();
    const total = (result.results ?? []).reduce((sum, p) => sum + (p.amount ?? 0), 0);
    return c.json({ success: true, data: { payments: result.results ?? [], total } });
  } catch (err) {
    console.error('GET /api/friends/:id/payments error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/:id/payments - add payment record
friends.post('/api/friends/:id/payments', async (c) => {
  try {
    const friendId = c.req.param('id');
    const body = await c.req.json<{ amount: number; note?: string; paidAt: string }>();
    if (!body.amount || !body.paidAt) {
      return c.json({ success: false, error: 'amount and paidAt required' }, 400);
    }
    const id = crypto.randomUUID();
    const now = jstNow();
    await c.env.DB
      .prepare(
        `INSERT INTO friend_payments (id, friend_id, amount, note, paid_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, friendId, Math.round(body.amount), body.note ?? null, body.paidAt, now, now)
      .run();
    return c.json({ success: true, data: { id } });
  } catch (err) {
    console.error('POST /api/friends/:id/payments error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/friends/:id/payments/:paymentId - update payment record
friends.put('/api/friends/:id/payments/:paymentId', async (c) => {
  try {
    const friendId = c.req.param('id');
    const paymentId = c.req.param('paymentId');
    const body = await c.req.json<{ amount?: number; note?: string | null; paidAt?: string }>();
    const updates: string[] = [];
    const values: (string | number | null)[] = [];
    if (body.amount !== undefined) { updates.push('amount = ?'); values.push(Math.round(body.amount)); }
    if (body.note !== undefined) { updates.push('note = ?'); values.push(body.note); }
    if (body.paidAt !== undefined) { updates.push('paid_at = ?'); values.push(body.paidAt); }
    if (updates.length === 0) return c.json({ success: false, error: 'no fields to update' }, 400);
    updates.push('updated_at = ?');
    values.push(jstNow());
    values.push(paymentId, friendId);
    await c.env.DB
      .prepare(`UPDATE friend_payments SET ${updates.join(', ')} WHERE id = ? AND friend_id = ?`)
      .bind(...values)
      .run();
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('PUT /api/friends/:id/payments/:paymentId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/friends/:id/payments/:paymentId - remove payment record
friends.delete('/api/friends/:id/payments/:paymentId', async (c) => {
  try {
    const friendId = c.req.param('id');
    const paymentId = c.req.param('paymentId');
    await c.env.DB
      .prepare('DELETE FROM friend_payments WHERE id = ? AND friend_id = ?')
      .bind(paymentId, friendId)
      .run();
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/friends/:id/payments/:paymentId error:', err);
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
          await notifyScenarioEnrolled(c.env.DISCORD_WEBHOOK_URL, db, friendId, scenario.id);
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

// PUT /api/friends/:id/block - toggle blocked status
friends.put('/api/friends/:id/block', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ isBlocked: boolean }>();
    await updateFriendBlocked(c.env.DB, id, body.isBlocked);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('PUT /api/friends/:id/block error:', err);
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
    let token = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (friend.line_account_id) {
      const account = await getLineAccountById(db, friend.line_account_id);
      if (account) token = account.channel_access_token;
    }
    const lineClient = new LineClient(token);
    const messageType = body.messageType ?? 'text';

    const { applyTrackingLinks } = await import('../services/step-delivery.js');
    const sendContent = c.env.TRACKING_BASE_URL
      ? applyTrackingLinks(body.content, c.env.TRACKING_BASE_URL, friend.id)
      : body.content;

    if (messageType === 'text') {
      await lineClient.pushMessage(friend.line_user_id, [{ type: 'text', text: sendContent }]);
    } else if (messageType === 'flex') {
      const contents = JSON.parse(sendContent);
      await lineClient.pushMessage(friend.line_user_id, [{ type: 'flex', altText: 'Message', contents }]);
    } else if (messageType === 'image') {
      const parsed = JSON.parse(sendContent);
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
