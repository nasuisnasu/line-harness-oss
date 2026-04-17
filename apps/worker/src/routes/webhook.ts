import { Hono } from 'hono';
import { verifySignature, LineClient } from '@line-crm/line-sdk';
import type { WebhookRequestBody, WebhookEvent, TextEventMessage } from '@line-crm/line-sdk';
import {
  upsertFriend,
  updateFriendFollowStatus,
  getFriendByLineUserId,
  getLineAccountById,
  getScenarios,
  getScenarioById,
  enrollFriendInScenario,
  getScenarioSteps,
  advanceFriendScenario,
  completeFriendScenario,
  upsertChatOnMessage,
  addTagToFriend,
  getEntryRouteByRefCode,
  jstNow,
} from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage, applyVars } from '../services/step-delivery.js';
import type { Env } from '../index.js';

const webhook = new Hono<Env>();

webhook.post('/webhook', async (c) => {
  const channelSecret = c.env.LINE_CHANNEL_SECRET;
  const signature = c.req.header('X-Line-Signature') ?? '';
  const rawBody = await c.req.text();

  // Always return 200 to LINE, but verify signature first
  const valid = await verifySignature(channelSecret, rawBody, signature);
  if (!valid) {
    console.error('Invalid LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  let body: WebhookRequestBody;
  try {
    body = JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    console.error('Failed to parse webhook body');
    return c.json({ status: 'ok' }, 200);
  }

  const db = c.env.DB;
  const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);

  // 非同期処理 — LINE は ~1s 以内のレスポンスを要求
  const lineAccessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  const processingPromise = (async () => {
    for (const event of body.events) {
      try {
        await handleEvent(db, lineClient, event, lineAccessToken);
      } catch (err) {
        console.error('Error handling webhook event:', err);
      }
    }
  })();

  c.executionCtx.waitUntil(processingPromise);

  return c.json({ status: 'ok' }, 200);
});

// Per-account webhook: POST /webhook/:accountId
webhook.post('/webhook/:accountId', async (c) => {
  const accountId = c.req.param('accountId');
  const db = c.env.DB;

  const account = await getLineAccountById(db, accountId);
  if (!account) {
    console.error('Webhook: account not found', accountId);
    return c.json({ status: 'ok' }, 200);
  }

  const signature = c.req.header('X-Line-Signature') ?? '';
  const rawBody = await c.req.text();

  const valid = await verifySignature(account.channel_secret, rawBody, signature);
  if (!valid) {
    console.error('Invalid LINE signature for account', accountId);
    return c.json({ status: 'ok' }, 200);
  }

  let body: WebhookRequestBody;
  try {
    body = JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    return c.json({ status: 'ok' }, 200);
  }

  const lineClient = new LineClient(account.channel_access_token);
  const processingPromise = (async () => {
    for (const event of body.events) {
      try {
        await handleEvent(db, lineClient, event, account.channel_access_token, accountId);
      } catch (err) {
        console.error('Error handling webhook event for account', accountId, err);
      }
    }
  })();

  c.executionCtx.waitUntil(processingPromise);
  return c.json({ status: 'ok' }, 200);
});

async function handleEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId?: string,
): Promise<void> {
  if (event.type === 'follow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    // プロフィール取得 & 友だち登録/更新
    let profile;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      console.error('Failed to get profile for', userId, err);
    }

    const friend = await upsertFriend(db, {
      lineUserId: userId,
      lineAccountId: lineAccountId ?? null,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });

    // friend_add シナリオに登録
    // 優先順位: friend の ref_code → entry_route.scenario_id → 全 friend_add シナリオ
    const friendRow = await db
      .prepare(`SELECT ref_code FROM friends WHERE id = ?`)
      .bind(friend.id)
      .first<{ ref_code: string | null }>();
    const refCode = friendRow?.ref_code ?? null;

    let scenariosToEnroll: { id: string; is_active: number | boolean }[] = [];

    if (refCode) {
      const route = await getEntryRouteByRefCode(db, refCode);
      if (route?.scenario_id) {
        const s = await getScenarioById(db, route.scenario_id);
        if (s && s.is_active) scenariosToEnroll = [s];
      }
    }

    // fallback: all active friend_add scenarios for this account
    if (scenariosToEnroll.length === 0) {
      const allScenarios = await getScenarios(db, lineAccountId);
      scenariosToEnroll = allScenarios.filter(s => s.trigger_type === 'friend_add' && s.is_active);
    }

    for (const scenario of scenariosToEnroll) {
      try {
        const existing = await db
          .prepare(`SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`)
          .bind(friend.id, scenario.id)
          .first<{ id: string }>();
        if (!existing) {
          const friendScenario = await enrollFriendInScenario(db, friend.id, scenario.id);

          // Immediate delivery: if the first step has delay=0, send it now
          const steps = await getScenarioSteps(db, scenario.id);
          const firstStep = steps[0];
          if (firstStep && firstStep.delay_minutes === 0 && friendScenario.status === 'active') {
            try {
              const content = applyVars(firstStep.message_content, { name: profile?.displayName ?? '' });
              const message = buildMessage(firstStep.message_type, content);
              await lineClient.pushMessage(userId, [message]);
              console.log(`Immediate delivery: sent step ${firstStep.id} to ${userId}`);

              // Log outgoing message
              const logId = crypto.randomUUID();
              await db
                .prepare(
                  `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
                   VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, ?)`,
                )
                .bind(logId, friend.id, firstStep.message_type, firstStep.message_content, firstStep.id, jstNow())
                .run();

              // Advance or complete the friend_scenario
              const secondStep = steps[1] ?? null;
              if (secondStep) {
                const nextDeliveryDate = new Date(Date.now() + 9 * 60 * 60_000);
                nextDeliveryDate.setMinutes(nextDeliveryDate.getMinutes() + secondStep.delay_minutes);
                await advanceFriendScenario(db, friendScenario.id, firstStep.step_order, nextDeliveryDate.toISOString().slice(0, -1) + '+09:00');
              } else {
                await completeFriendScenario(db, friendScenario.id);
              }
            } catch (err) {
              console.error('Failed immediate delivery for scenario', scenario.id, err);
            }
          }
        }
      } catch (err) {
        console.error('Failed to enroll friend in scenario', scenario.id, err);
      }
    }

    // イベントバス発火: friend_add
    await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName: friend.display_name } }, lineAccessToken);
    return;
  }

  if (event.type === 'unfollow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    await updateFriendFollowStatus(db, userId, false, lineAccountId ?? null);
    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const textMessage = event.message as TextEventMessage;
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await getFriendByLineUserId(db, userId, lineAccountId ?? null);
    if (!friend) return;

    const incomingText = textMessage.text;
    const now = jstNow();
    const logId = crypto.randomUUID();

    // 受信メッセージをログに記録
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
         VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, ?)`,
      )
      .bind(logId, friend.id, incomingText, now)
      .run();

    // チャットを作成/更新（オペレーター機能連携）
    await upsertChatOnMessage(db, friend.id);

    // 自動返信チェック
    // NOTE: Auto-replies use replyMessage (free, no quota) instead of pushMessage
    // The replyToken is only valid for ~1 minute after the message event
    const autoReplies = await db
      .prepare(`SELECT * FROM auto_replies WHERE is_active = 1 ORDER BY created_at ASC`)
      .all<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains';
        response_type: string;
        response_content: string;
        is_active: number;
        created_at: string;
      }>();

    let matched = false;
    for (const rule of autoReplies.results) {
      const isMatch =
        rule.match_type === 'exact'
          ? incomingText === rule.keyword
          : incomingText.includes(rule.keyword);

      if (isMatch) {
        try {
          if (rule.response_type === 'text') {
            await lineClient.replyMessage(event.replyToken, [
              { type: 'text', text: rule.response_content },
            ]);
          } else if (rule.response_type === 'image') {
            const parsed = JSON.parse(rule.response_content) as {
              originalContentUrl: string;
              previewImageUrl: string;
            };
            await lineClient.replyMessage(event.replyToken, [
              { type: 'image', originalContentUrl: parsed.originalContentUrl, previewImageUrl: parsed.previewImageUrl },
            ]);
          } else if (rule.response_type === 'flex') {
            const contents = JSON.parse(rule.response_content);
            await lineClient.replyMessage(event.replyToken, [
              { type: 'flex', altText: 'Message', contents },
            ]);
          }

          // 送信ログ
          const outLogId = crypto.randomUUID();
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, ?)`,
            )
            .bind(outLogId, friend.id, rule.response_type, rule.response_content, jstNow())
            .run();
        } catch (err) {
          console.error('Failed to send auto-reply', err);
        }

        matched = true;
        break;
      }
    }

    // イベントバス発火: message_received
    await fireEvent(db, 'message_received', {
      friendId: friend.id,
      eventData: { text: incomingText, matched },
    }, lineAccessToken);

    return;
  }

  if (event.type === 'postback') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await getFriendByLineUserId(db, userId, lineAccountId ?? null);
    if (!friend) return;

    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');

    if (action === 'assign_tag') {
      const tagId = params.get('tag_id');
      if (!tagId) return;

      await addTagToFriend(db, friend.id, tagId);

      // tag_added シナリオを発火
      await enrollTagScenarios(db, friend.id, tagId, userId, lineAccessToken);

      // イベントバス発火: tag_added
      await fireEvent(db, 'tag_added', {
        friendId: friend.id,
        eventData: { tagId },
      }, lineAccessToken);
    }

    return;
  }
}

async function enrollTagScenarios(
  db: D1Database,
  friendId: string,
  tagId: string,
  lineUserId: string,
  lineAccessToken: string,
): Promise<void> {
  const scenarios = await getScenarios(db);
  const lineClient = new LineClient(lineAccessToken);

  for (const scenario of scenarios) {
    if (
      scenario.trigger_type === 'tag_added' &&
      scenario.trigger_tag_id === tagId &&
      scenario.is_active
    ) {
      const existing = await db
        .prepare(`SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`)
        .bind(friendId, scenario.id)
        .first<{ id: string }>();
      if (existing) continue;

      const friendScenario = await enrollFriendInScenario(db, friendId, scenario.id);
      const steps = await getScenarioSteps(db, scenario.id);
      const firstStep = steps[0];

      if (firstStep && firstStep.delay_minutes === 0 && friendScenario.status === 'active') {
        try {
          const message = buildMessage(firstStep.message_type, firstStep.message_content);
          await lineClient.pushMessage(lineUserId, [message]);

          const logId = crypto.randomUUID();
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, ?)`,
            )
            .bind(logId, friendId, firstStep.message_type, firstStep.message_content, firstStep.id, jstNow())
            .run();

          const secondStep = steps[1] ?? null;
          if (secondStep) {
            const nextDeliveryDate = new Date(Date.now() + 9 * 60 * 60_000);
            nextDeliveryDate.setMinutes(nextDeliveryDate.getMinutes() + secondStep.delay_minutes);
            await advanceFriendScenario(db, friendScenario.id, firstStep.step_order, nextDeliveryDate.toISOString().slice(0, -1) + '+09:00');
          } else {
            await completeFriendScenario(db, friendScenario.id);
          }
        } catch (err) {
          console.error('Failed immediate delivery for tag scenario', scenario.id, err);
        }
      }
    }
  }
}

export { webhook };
