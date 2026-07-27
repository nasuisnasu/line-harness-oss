import { Hono } from 'hono';
import {
  jstNow,
  getFriendsByTag,
  getFriendsExcludingTag,
  addTagToFriend,
  enrollFriendInScenario,
  getLineAccountById,
  getRichMenuById,
} from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../index.js';

/**
 * Bulk action runner — executes "L-step スタイル" segment-wide operations:
 *   - enroll_scenario: enroll every matching friend into a scenario
 *   - add_tag:         attach a tag to every matching friend
 *   - set_richmenu:    swap each friend's per-user rich menu
 *
 * Targets are resolved via the same tag-include / tag-exclude / all
 * semantics as broadcasts so operators reuse their mental model. Execution
 * runs synchronously inside a single request — fine for the current scale
 * (low-thousand friends per OA). If volumes grow we'll move this onto the
 * existing 5-minute cron and stage `pending → running → completed`.
 */
const actions = new Hono<Env>();

interface TargetSpec {
  mode: 'all' | 'tag_include' | 'tag_exclude';
  tagId?: string | null;
}

interface FriendRow {
  id: string;
  line_user_id: string;
  line_account_id: string | null;
}

async function resolveTargets(
  db: D1Database,
  spec: TargetSpec,
  lineAccountId: string,
): Promise<FriendRow[]> {
  if (spec.mode === 'tag_include') {
    if (!spec.tagId) return [];
    const all = await getFriendsByTag(db, spec.tagId);
    return all
      .filter((f) => f.line_account_id === lineAccountId)
      .map((f) => ({ id: f.id, line_user_id: f.line_user_id, line_account_id: f.line_account_id ?? null }));
  }
  if (spec.mode === 'tag_exclude') {
    if (!spec.tagId) return [];
    const all = await getFriendsExcludingTag(db, spec.tagId, lineAccountId);
    return all.map((f) => ({ id: f.id, line_user_id: f.line_user_id, line_account_id: f.line_account_id ?? null }));
  }
  // 'all' — every friend on this account
  const result = await db
    .prepare(`SELECT id, line_user_id, line_account_id FROM friends WHERE line_account_id = ? AND is_following = 1`)
    .bind(lineAccountId)
    .all<FriendRow>();
  return result.results;
}

actions.get('/api/actions', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const stmt = lineAccountId
      ? c.env.DB.prepare(`SELECT * FROM bulk_actions WHERE line_account_id = ? ORDER BY created_at DESC LIMIT 100`).bind(lineAccountId)
      : c.env.DB.prepare(`SELECT * FROM bulk_actions ORDER BY created_at DESC LIMIT 100`);
    const result = await stmt.all<{
      id: string;
      line_account_id: string | null;
      name: string;
      action_type: string;
      action_payload: string;
      target_spec: string;
      status: string;
      total_targets: number;
      processed_count: number;
      failed_count: number;
      error_log: string | null;
      executed_at: string | null;
      created_at: string;
    }>();
    return c.json({
      success: true,
      data: result.results.map((r) => ({
        id: r.id,
        lineAccountId: r.line_account_id,
        name: r.name,
        actionType: r.action_type,
        actionPayload: JSON.parse(r.action_payload),
        targetSpec: JSON.parse(r.target_spec),
        status: r.status,
        totalTargets: r.total_targets,
        processedCount: r.processed_count,
        failedCount: r.failed_count,
        errorLog: r.error_log,
        executedAt: r.executed_at,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/actions error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

actions.post('/api/actions', async (c) => {
  try {
    const body = await c.req.json<{
      lineAccountId: string;
      name: string;
      actionType: 'enroll_scenario' | 'add_tag' | 'set_richmenu';
      actionPayload: { scenarioId?: string; tagId?: string; richMenuId?: string };
      targetSpec: TargetSpec;
    }>();

    if (!body.lineAccountId || !body.name || !body.actionType || !body.actionPayload || !body.targetSpec) {
      return c.json({ success: false, error: 'lineAccountId, name, actionType, actionPayload, targetSpec are required' }, 400);
    }
    if (body.actionType === 'enroll_scenario' && !body.actionPayload.scenarioId) {
      return c.json({ success: false, error: 'scenarioId is required for enroll_scenario' }, 400);
    }
    if (body.actionType === 'add_tag' && !body.actionPayload.tagId) {
      return c.json({ success: false, error: 'tagId is required for add_tag' }, 400);
    }
    if (body.actionType === 'set_richmenu' && !body.actionPayload.richMenuId) {
      return c.json({ success: false, error: 'richMenuId is required for set_richmenu' }, 400);
    }

    const id = crypto.randomUUID();
    const now = jstNow();

    // Insert in pending state so even if execution crashes mid-way we have
    // an audit row of *what was attempted*. The status updates below mark
    // the lifecycle.
    await c.env.DB
      .prepare(
        `INSERT INTO bulk_actions (id, line_account_id, name, action_type, action_payload, target_spec, status, total_targets, processed_count, failed_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 0, 0, ?, ?)`,
      )
      .bind(
        id,
        body.lineAccountId,
        body.name,
        body.actionType,
        JSON.stringify(body.actionPayload),
        JSON.stringify(body.targetSpec),
        now,
        now,
      )
      .run();

    const targets = await resolveTargets(c.env.DB, body.targetSpec, body.lineAccountId);
    await c.env.DB
      .prepare(`UPDATE bulk_actions SET total_targets = ?, status = 'running', updated_at = ? WHERE id = ?`)
      .bind(targets.length, jstNow(), id)
      .run();

    let processed = 0;
    let failed = 0;
    const errors: string[] = [];

    let lineClient: LineClient | null = null;
    // set_richmenu の richMenuId は harness 内部のUUID。LINE API は line_richmenu_id
    // （richmenu-…）を要求するため、ここで一度だけ解決してループで使い回す。
    let lineRichmenuId = '';
    if (body.actionType === 'set_richmenu') {
      const account = await getLineAccountById(c.env.DB, body.lineAccountId);
      if (!account) {
        await c.env.DB
          .prepare(`UPDATE bulk_actions SET status = 'failed', error_log = ?, updated_at = ? WHERE id = ?`)
          .bind('LINE account not found', jstNow(), id)
          .run();
        return c.json({ success: false, error: 'LINE account not found' }, 404);
      }
      const menu = await getRichMenuById(c.env.DB, body.actionPayload.richMenuId!);
      if (!menu || !menu.line_richmenu_id) {
        const msg = menu ? 'リッチメニューがLINEに未公開です（line_richmenu_id なし）' : 'リッチメニューが見つかりません';
        await c.env.DB
          .prepare(`UPDATE bulk_actions SET status = 'failed', error_log = ?, updated_at = ? WHERE id = ?`)
          .bind(msg, jstNow(), id)
          .run();
        return c.json({ success: false, error: msg }, 400);
      }
      lineRichmenuId = menu.line_richmenu_id;
      lineClient = new LineClient(account.channel_access_token);
    }

    // 「全員」へのリッチメニュー切替は、1人ずつリンクすると友だち数ぶんの
    // subrequest が必要になり、Workers の上限（無料プラン50回）で頭打ちになる。
    // LINEの「デフォルトリッチメニュー」APIなら全ユーザーに1コールで一括適用できる。
    if (body.actionType === 'set_richmenu' && body.targetSpec.mode === 'all' && lineClient) {
      try {
        await lineClient.setDefaultRichMenu(lineRichmenuId);
        await c.env.DB
          .prepare(
            `UPDATE bulk_actions SET status = 'completed', processed_count = ?, failed_count = 0, executed_at = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(targets.length, jstNow(), jstNow(), id)
          .run();
        return c.json({ success: true, data: { id, processed: targets.length, failed: 0, mode: 'default_richmenu' } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await c.env.DB
          .prepare(`UPDATE bulk_actions SET status = 'failed', error_log = ?, updated_at = ? WHERE id = ?`)
          .bind(msg, jstNow(), id)
          .run();
        return c.json({ success: false, error: msg }, 502);
      }
    }

    for (const friend of targets) {
      try {
        if (body.actionType === 'add_tag') {
          await addTagToFriend(c.env.DB, friend.id, body.actionPayload.tagId!);
        } else if (body.actionType === 'enroll_scenario') {
          await enrollFriendInScenario(c.env.DB, friend.id, body.actionPayload.scenarioId!);
        } else if (body.actionType === 'set_richmenu' && lineClient) {
          await lineClient.linkRichMenuToUser(friend.line_user_id, lineRichmenuId);
        }
        processed += 1;
      } catch (err) {
        failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        if (errors.length < 20) errors.push(`${friend.id}: ${msg}`);
      }
    }

    const finalStatus = failed === 0 ? 'completed' : (processed === 0 ? 'failed' : 'completed');
    await c.env.DB
      .prepare(
        `UPDATE bulk_actions SET status = ?, processed_count = ?, failed_count = ?, error_log = ?, executed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(
        finalStatus,
        processed,
        failed,
        errors.length > 0 ? errors.join('\n') : null,
        jstNow(),
        jstNow(),
        id,
      )
      .run();

    return c.json({
      success: true,
      data: { id, totalTargets: targets.length, processed, failed, status: finalStatus },
    }, 201);
  } catch (err) {
    console.error('POST /api/actions error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }
});

actions.delete('/api/actions/:id', async (c) => {
  try {
    await c.env.DB.prepare(`DELETE FROM bulk_actions WHERE id = ?`).bind(c.req.param('id')).run();
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/actions/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { actions };
