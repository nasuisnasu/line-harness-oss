import { Hono } from 'hono';
import {
  getScenarios,
  getScenarioById,
  createScenario,
  updateScenario,
  deleteScenario,
  createScenarioStep,
  updateScenarioStep,
  deleteScenarioStep,
  enrollFriendInScenario,
  getFriendById,
  getLineAccountById,
  getScenarioSteps,
} from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { applyVars, applyTrackingLinks, buildMessage } from '../services/step-delivery.js';
import type {
  Scenario as DbScenario,
  ScenarioWithStepCount as DbScenarioWithStepCount,
  ScenarioStep as DbScenarioStep,
  FriendScenario as DbFriendScenario,
  ScenarioTriggerType,
  MessageType,
} from '@line-crm/db';
import type { Env } from '../index.js';

const scenarios = new Hono<Env>();

/** Convert D1 snake_case Scenario row to shared camelCase shape */
function serializeScenario(row: DbScenario) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    triggerType: row.trigger_type,
    triggerTagId: row.trigger_tag_id,
    isActive: Boolean(row.is_active),
    groupName: row.group_name ?? null,
    nextScenarioId: row.next_scenario_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Convert D1 snake_case ScenarioStep row to shared camelCase shape */
function serializeStep(row: DbScenarioStep) {
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    stepOrder: row.step_order,
    delayMinutes: row.delay_minutes,
    delayMode: row.delay_mode ?? 'relative',
    delayDays: row.delay_days ?? null,
    delayTime: row.delay_time ?? null,
    delayAt: row.delay_at ?? null,
    messageType: row.message_type,
    messageContent: row.message_content,
    conditionType: row.condition_type ?? null,
    conditionValue: row.condition_value ?? null,
    nextStepOnFalse: row.next_step_on_false ?? null,
    richMenuId: row.rich_menu_id ?? null,
    templateId: row.template_id ?? null,
    createdAt: row.created_at,
  };
}

/** Convert D1 snake_case FriendScenario row to shared camelCase shape */
function serializeFriendScenario(row: DbFriendScenario) {
  return {
    id: row.id,
    friendId: row.friend_id,
    scenarioId: row.scenario_id,
    currentStepOrder: row.current_step_order,
    status: row.status,
    startedAt: row.started_at,
    nextDeliveryAt: row.next_delivery_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/scenarios - list all
scenarios.get('/api/scenarios', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const items = await getScenarios(c.env.DB, lineAccountId);
    return c.json({
      success: true,
      data: items.map((row) => ({
        ...serializeScenario(row),
        stepCount: row.step_count,
      })),
    });
  } catch (err) {
    console.error('GET /api/scenarios error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/scenarios/:id - get with steps
scenarios.get('/api/scenarios/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const scenario = await getScenarioById(c.env.DB, id);

    if (!scenario) {
      return c.json({ success: false, error: 'Scenario not found' }, 404);
    }

    return c.json({
      success: true,
      data: {
        ...serializeScenario(scenario),
        steps: scenario.steps.map(serializeStep),
      },
    });
  } catch (err) {
    console.error('GET /api/scenarios/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/scenarios - create
// POST /api/scenarios/groups/rename — bulk rename a group label across
// all scenario rows so an operator can fix typos without touching each
// scenario individually.
scenarios.post('/api/scenarios/groups/rename', async (c) => {
  try {
    const body = await c.req.json<{ from: string; to: string | null }>();
    if (!body.from) {
      return c.json({ success: false, error: 'from is required' }, 400);
    }
    const target = body.to === null || body.to === undefined ? null : String(body.to).trim() || null;
    const res = await c.env.DB
      .prepare(`UPDATE scenarios SET group_name = ? WHERE group_name = ?`)
      .bind(target, body.from)
      .run();
    const changes = (res as { meta?: { changes?: number } }).meta?.changes ?? 0;
    return c.json({ success: true, data: { changes } });
  } catch (err) {
    console.error('POST /api/scenarios/groups/rename error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

scenarios.post('/api/scenarios', async (c) => {
  try {
    const body = await c.req.json<{
      name: string;
      description?: string | null;
      triggerType: ScenarioTriggerType;
      triggerTagId?: string | null;
      isActive?: boolean;
      groupName?: string | null;
    }>();

    if (!body.name || !body.triggerType) {
      return c.json({ success: false, error: 'name and triggerType are required' }, 400);
    }

    const lineAccountId = c.req.query('lineAccountId') ?? (body as Record<string, unknown>).lineAccountId as string ?? null;
    let scenario = await createScenario(c.env.DB, {
      name: body.name,
      description: body.description ?? null,
      triggerType: body.triggerType,
      triggerTagId: body.triggerTagId ?? null,
      lineAccountId,
      groupName: body.groupName ?? null,
    });

    // createScenario() always sets is_active=1; override if the caller requested inactive
    if (body.isActive === false) {
      const updated = await updateScenario(c.env.DB, scenario.id, { is_active: 0 });
      if (updated) scenario = updated;
    }

    return c.json({ success: true, data: serializeScenario(scenario) }, 201);
  } catch (err) {
    console.error('POST /api/scenarios error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/scenarios/:id - update (accepts camelCase fields from clients)
scenarios.put('/api/scenarios/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      name?: string;
      description?: string | null;
      triggerType?: ScenarioTriggerType;
      triggerTagId?: string | null;
      isActive?: boolean;
      groupName?: string | null;
      nextScenarioId?: string | null;
    }>();

    // Cycle guard: walk the chain forward from the requested next-id and
    // reject if we hit `id` again. We cap depth to prevent runaway
    // queries on operator-introduced cycles in unrelated chains.
    if (body.nextScenarioId !== undefined && body.nextScenarioId) {
      if (body.nextScenarioId === id) {
        return c.json({ success: false, error: '自分自身を次のシナリオに指定できません' }, 400);
      }
      let cursor: string | null = body.nextScenarioId;
      const visited = new Set<string>([id]);
      for (let depth = 0; depth < 100 && cursor; depth++) {
        if (visited.has(cursor)) {
          return c.json({ success: false, error: '次シナリオの循環参照が発生します' }, 400);
        }
        visited.add(cursor);
        const row = await c.env.DB
          .prepare(`SELECT next_scenario_id FROM scenarios WHERE id = ?`)
          .bind(cursor)
          .first<{ next_scenario_id: string | null }>();
        cursor = row?.next_scenario_id ?? null;
      }
    }

    const updated = await updateScenario(c.env.DB, id, {
      name: body.name,
      description: body.description,
      trigger_type: body.triggerType,
      trigger_tag_id: body.triggerTagId,
      is_active: body.isActive !== undefined ? (body.isActive ? 1 : 0) : undefined,
      group_name: body.groupName,
      next_scenario_id: body.nextScenarioId,
    });

    if (!updated) {
      return c.json({ success: false, error: 'Scenario not found' }, 404);
    }

    return c.json({ success: true, data: serializeScenario(updated) });
  } catch (err) {
    console.error('PUT /api/scenarios/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/scenarios/:id - delete
scenarios.delete('/api/scenarios/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await deleteScenario(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/scenarios/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/scenarios/:id/steps - add step
scenarios.post('/api/scenarios/:id/steps', async (c) => {
  try {
    const scenarioId = c.req.param('id');
    const body = await c.req.json<{
      stepOrder: number;
      delayMinutes?: number;
      delayMode?: 'relative' | 'days_at_time' | 'absolute';
      delayDays?: number | null;
      delayTime?: string | null;
      delayAt?: string | null;
      messageType: MessageType;
      messageContent: string;
      conditionType?: string | null;
      conditionValue?: string | null;
      nextStepOnFalse?: number | null;
      richMenuId?: string | null;
      templateId?: string | null;
    }>();

    if (body.stepOrder === undefined || !body.messageType) {
      return c.json(
        { success: false, error: 'stepOrder and messageType are required' },
        400,
      );
    }
    // richmenuタイプはmessageContent不要、それ以外は必須
    if (body.messageType !== 'richmenu' && !body.messageContent) {
      return c.json({ success: false, error: 'messageContent is required' }, 400);
    }
    if (body.delayMode === 'days_at_time') {
      if (body.delayDays == null || body.delayDays < 0) {
        return c.json({ success: false, error: 'delayDays は0以上の整数を指定してください' }, 400);
      }
      if (!body.delayTime || !/^\d{1,2}:\d{2}$/.test(body.delayTime)) {
        return c.json({ success: false, error: 'delayTime は HH:MM 形式で指定してください' }, 400);
      }
    }
    if (body.delayMode === 'absolute') {
      if (!body.delayAt || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(body.delayAt)) {
        return c.json({ success: false, error: 'delayAt は YYYY-MM-DDTHH:MM 形式で指定してください' }, 400);
      }
    }

    const step = await createScenarioStep(c.env.DB, {
      scenarioId,
      stepOrder: body.stepOrder,
      delayMinutes: body.delayMinutes ?? 0,
      delayMode: body.delayMode ?? 'relative',
      delayDays: body.delayDays ?? null,
      delayTime: body.delayTime ?? null,
      delayAt: body.delayAt ?? null,
      messageType: body.messageType,
      messageContent: body.messageContent ?? '',
      conditionType: body.conditionType ?? null,
      conditionValue: body.conditionValue ?? null,
      nextStepOnFalse: body.nextStepOnFalse ?? null,
      richMenuId: body.richMenuId ?? null,
      templateId: body.templateId ?? null,
    });

    return c.json({ success: true, data: serializeStep(step) }, 201);
  } catch (err) {
    console.error('POST /api/scenarios/:id/steps error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/scenarios/:id/steps/:stepId - update step (accepts camelCase)
scenarios.put('/api/scenarios/:id/steps/:stepId', async (c) => {
  try {
    const stepId = c.req.param('stepId');
    const body = await c.req.json<{
      stepOrder?: number;
      delayMinutes?: number;
      delayMode?: 'relative' | 'days_at_time' | 'absolute';
      delayDays?: number | null;
      delayTime?: string | null;
      delayAt?: string | null;
      messageType?: MessageType;
      messageContent?: string;
      conditionType?: string | null;
      conditionValue?: string | null;
      nextStepOnFalse?: number | null;
      richMenuId?: string | null;
      templateId?: string | null;
    }>();
    if (body.delayMode === 'days_at_time') {
      if (body.delayDays != null && body.delayDays < 0) {
        return c.json({ success: false, error: 'delayDays は0以上' }, 400);
      }
      if (body.delayTime != null && !/^\d{1,2}:\d{2}$/.test(body.delayTime)) {
        return c.json({ success: false, error: 'delayTime は HH:MM' }, 400);
      }
    }
    if (body.delayMode === 'absolute') {
      if (body.delayAt != null && !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(body.delayAt)) {
        return c.json({ success: false, error: 'delayAt は YYYY-MM-DDTHH:MM 形式' }, 400);
      }
    }

    const updated = await updateScenarioStep(c.env.DB, stepId, {
      step_order: body.stepOrder,
      delay_minutes: body.delayMinutes,
      delay_mode: body.delayMode,
      delay_days: body.delayDays,
      delay_time: body.delayTime,
      delay_at: body.delayAt,
      message_type: body.messageType,
      message_content: body.messageContent,
      condition_type: body.conditionType,
      condition_value: body.conditionValue,
      next_step_on_false: body.nextStepOnFalse,
      rich_menu_id: body.richMenuId,
      template_id: body.templateId,
    });

    if (!updated) {
      return c.json({ success: false, error: 'Step not found' }, 404);
    }

    return c.json({ success: true, data: serializeStep(updated) });
  } catch (err) {
    console.error('PUT /api/scenarios/:id/steps/:stepId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/scenarios/:id/steps/:stepId - delete step
scenarios.delete('/api/scenarios/:id/steps/:stepId', async (c) => {
  try {
    const stepId = c.req.param('stepId');
    await deleteScenarioStep(c.env.DB, stepId);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/scenarios/:id/steps/:stepId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * テスト送信のヘルパー
 * シナリオに紐づくLINEアカウントの test_friend_id へ、指定ステップのメッセージを送信する。
 */
async function sendTestSteps(
  c: { env: Env['Bindings'] },
  scenarioId: string,
  stepIds?: string[],
): Promise<{ success: true; data: { sentTo: string; sentCount: number } } | { success: false; error: string; status: number }> {
  const db = c.env.DB;
  const scenario = await getScenarioById(db, scenarioId);
  if (!scenario) return { success: false, error: 'Scenario not found', status: 404 };
  if (!scenario.line_account_id) return { success: false, error: 'このシナリオにはLINEアカウントが紐づいていません', status: 400 };

  const account = await getLineAccountById(db, scenario.line_account_id);
  if (!account) return { success: false, error: 'LINE account not found', status: 404 };
  if (!account.test_friend_id) return { success: false, error: 'このLINEアカウントにはテスト送信先が設定されていません', status: 400 };

  const friend = await getFriendById(db, account.test_friend_id);
  if (!friend) return { success: false, error: 'テスト送信先の友達が見つかりません', status: 404 };

  const allSteps = await getScenarioSteps(db, scenarioId);
  const targetSteps = stepIds
    ? allSteps.filter((s) => stepIds.includes(s.id)).sort((a, b) => a.step_order - b.step_order)
    : allSteps;

  if (targetSteps.length === 0) return { success: false, error: 'テスト送信できるステップがありません', status: 400 };

  const lineClient = new LineClient(account.channel_access_token);
  let sentCount = 0;
  for (const step of targetSteps) {
    let content = applyVars(step.message_content, { name: friend.display_name ?? '' });
    if (c.env.TRACKING_BASE_URL) {
      content = applyTrackingLinks(content, c.env.TRACKING_BASE_URL, friend.id);
    }
    const message = buildMessage(step.message_type, content);
    await lineClient.pushMessage(friend.line_user_id, [message]);
    sentCount++;
  }
  return { success: true, data: { sentTo: friend.display_name ?? friend.line_user_id, sentCount } };
}

// POST /api/scenarios/:id/test - シナリオの全ステップを一気にテスト送信
scenarios.post('/api/scenarios/:id/test', async (c) => {
  try {
    const result = await sendTestSteps(c, c.req.param('id'));
    if (!result.success) return c.json({ success: false, error: result.error }, result.status as 400 | 404);
    return c.json(result);
  } catch (err) {
    console.error('POST /api/scenarios/:id/test error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }
});

// POST /api/scenarios/:id/steps/:stepId/test - 特定ステップ1通だけテスト送信
scenarios.post('/api/scenarios/:id/steps/:stepId/test', async (c) => {
  try {
    const result = await sendTestSteps(c, c.req.param('id'), [c.req.param('stepId')]);
    if (!result.success) return c.json({ success: false, error: result.error }, result.status as 400 | 404);
    return c.json(result);
  } catch (err) {
    console.error('POST /api/scenarios/:id/steps/:stepId/test error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }
});

// POST /api/scenarios/:id/enroll/:friendId - manually enroll friend
scenarios.post('/api/scenarios/:id/enroll/:friendId', async (c) => {
  try {
    const scenarioId = c.req.param('id');
    const friendId = c.req.param('friendId');
    const db = c.env.DB;

    // Verify both exist
    const [scenario, friend] = await Promise.all([
      getScenarioById(db, scenarioId),
      getFriendById(db, friendId),
    ]);

    if (!scenario) {
      return c.json({ success: false, error: 'Scenario not found' }, 404);
    }
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const enrollment = await enrollFriendInScenario(db, friendId, scenarioId);
    return c.json({ success: true, data: serializeFriendScenario(enrollment) }, 201);
  } catch (err) {
    console.error('POST /api/scenarios/:id/enroll/:friendId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { scenarios };
