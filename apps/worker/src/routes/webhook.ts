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
  getEntryRouteTagIds,
  getFriendAddRichMenu,
  jstNow,
  toJstString,
} from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage, applyVars, applyTrackingLinks } from '../services/step-delivery.js';
import { notifyScenarioEnrolled } from '../services/discord-notify.js';
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
  const discordWebhookUrl = c.env.DISCORD_WEBHOOK_URL;
  const processingPromise = (async () => {
    for (const event of body.events) {
      try {
        await handleEvent(db, lineClient, event, lineAccessToken, undefined, discordWebhookUrl);
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
  const discordWebhookUrl = c.env.DISCORD_WEBHOOK_URL;
  const processingPromise = (async () => {
    for (const event of body.events) {
      try {
        await handleEvent(db, lineClient, event, account.channel_access_token, accountId, discordWebhookUrl);
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
  discordWebhookUrl?: string,
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
    // LIFFが先にref_codeをセットした場合、別line_account_idのレコードにある可能性があるため全レコードを探す
    const friendRow = await db
      .prepare(`SELECT ref_code FROM friends WHERE line_user_id = ? AND ref_code IS NOT NULL LIMIT 1`)
      .bind(userId)
      .first<{ ref_code: string | null }>();
    const refCode = friendRow?.ref_code ?? null;

    // ref_codeが見つかれば、このfriendレコードにも転記しておく
    if (refCode && !(friend as unknown as Record<string, unknown>).ref_code) {
      await db.prepare(`UPDATE friends SET ref_code = ? WHERE id = ? AND ref_code IS NULL`)
        .bind(refCode, friend.id).run();
    }

    let scenariosToEnroll: { id: string; is_active: number | boolean }[] = [];
    let routeFound = false;

    if (refCode) {
      const route = await getEntryRouteByRefCode(db, refCode);
      if (route) {
        routeFound = true;
        if (route.scenario_id) {
          const s = await getScenarioById(db, route.scenario_id);
          if (s && s.is_active) scenariosToEnroll = [s];
        }
        // 自動付与タグを全部付ける（旧tag_id + 中間テーブル）
        try {
          const autoTagIds = await getEntryRouteTagIds(db, route);
          for (const tagId of autoTagIds) {
            await addTagToFriend(db, friend.id, tagId);
          }
        } catch (e) {
          console.error('Auto-tag attachment error:', e);
        }
      }
    }

    // 流入経路不明の場合はアカウント設定のフォールバックメッセージを送信
    if (!routeFound && lineAccountId) {
      try {
        const account = await getLineAccountById(db, lineAccountId);
        if (account?.welcome_fallback_message) {
          await lineClient.pushMessage(userId, [{
            type: 'text',
            text: account.welcome_fallback_message,
          }]);
        }
      } catch (e) {
        console.error('Fallback message send error:', e);
      }
    }

    for (const scenario of scenariosToEnroll) {
      try {
        const existing = await db
          .prepare(`SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`)
          .bind(friend.id, scenario.id)
          .first<{ id: string }>();
        if (!existing) {
          const friendScenario = await enrollFriendInScenario(db, friend.id, scenario.id);
          await notifyScenarioEnrolled(discordWebhookUrl, db, friend.id, scenario.id);

          // Immediate delivery: if the first step has delay=0, send it now
          const steps = await getScenarioSteps(db, scenario.id);
          const firstStep = steps[0];
          if (firstStep && firstStep.delay_minutes === 0 && friendScenario.status === 'active') {
            try {
              let content = applyVars(firstStep.message_content, { name: profile?.displayName ?? '', friendId: friend.id });
              if (c.env.TRACKING_BASE_URL) {
                content = applyTrackingLinks(content, c.env.TRACKING_BASE_URL, friend.id);
              }
              const message = buildMessage(firstStep.message_type, content);
              await lineClient.pushMessage(userId, [message]);
              console.log(`Immediate delivery: sent step ${firstStep.id} to ${userId}`);

              // Log outgoing message and ensure chat room
              const logId = crypto.randomUUID();
              const logNow = jstNow();
              await db
                .prepare(
                  `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
                   VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, ?)`,
                )
                .bind(logId, friend.id, firstStep.message_type, content, firstStep.id, logNow)
                .run();
              const existingChat = await db.prepare(`SELECT id FROM chats WHERE friend_id = ?`).bind(friend.id).first<{ id: string }>();
              if (existingChat) {
                await db.prepare(`UPDATE chats SET last_message_at = ?, updated_at = ? WHERE id = ?`).bind(logNow, logNow, existingChat.id).run();
              } else {
                await db.prepare(`INSERT INTO chats (id, friend_id, status, last_message_at, created_at, updated_at) VALUES (?, ?, 'unread', ?, ?, ?)`)
                  .bind(crypto.randomUUID(), friend.id, logNow, logNow, logNow).run();
              }

              // Advance or complete the friend_scenario
              const secondStep = steps[1] ?? null;
              if (secondStep) {
                const nextDeliveryDate = new Date();
                nextDeliveryDate.setMinutes(nextDeliveryDate.getMinutes() + secondStep.delay_minutes);
                await advanceFriendScenario(db, friendScenario.id, firstStep.step_order, toJstString(nextDeliveryDate));
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

    // 友達追加時用リッチメニューを自動Link（アカウントごとに1つ）
    if (lineAccountId) {
      try {
        const friendAddMenu = await getFriendAddRichMenu(db, lineAccountId);
        if (friendAddMenu?.line_richmenu_id) {
          await lineClient.linkRichMenuToUser(userId, friendAddMenu.line_richmenu_id);
        }
      } catch (e) {
        console.error('Friend-add rich menu link error:', e);
      }
    }

    // イベントバス発火: friend_add
    await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName: friend.display_name } }, lineAccessToken);

    // Discord通知
    if (discordWebhookUrl) {
      const name = profile?.displayName ?? '不明';
      const source = refCode ? `流入: ${refCode}` : '流入: 不明';
      await fetch(discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `🎉 LINE友だち追加: **${name}** | ${source}` }),
      }).catch(() => {});
    }
    return;
  }

  if (event.type === 'unfollow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    await updateFriendFollowStatus(db, userId, false, lineAccountId ?? null);
    return;
  }

  // Non-text messages (sticker / image / video / audio / file / location)
  // weren't being recorded at all, so the chat list never lit up when a
  // friend reacted with a sticker. Log them with a human-readable
  // placeholder so the operator at least sees the chat update.
  if (event.type === 'message' && event.message.type !== 'text') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;
    const friend = await getFriendByLineUserId(db, userId, lineAccountId ?? null);
    if (!friend) return;

    const m = event.message as { type: string; packageId?: string; stickerId?: string; id?: string };
    const placeholder =
      m.type === 'sticker'
        ? `[スタンプ] pkg=${m.packageId ?? '?'} id=${m.stickerId ?? '?'}`
        : m.type === 'image'
          ? '[画像]'
          : m.type === 'video'
            ? '[動画]'
            : m.type === 'audio'
              ? '[音声]'
              : m.type === 'file'
                ? '[ファイル]'
                : m.type === 'location'
                  ? '[位置情報]'
                  : `[${m.type}]`;
    const now = jstNow();
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
         VALUES (?, ?, 'incoming', ?, ?, NULL, NULL, ?)`,
      )
      .bind(crypto.randomUUID(), friend.id, m.type, placeholder, now)
      .run();
    await upsertChatOnMessage(db, friend.id);
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

    // Auto-reply rules — scope by account so a keyword on OA-A doesn't fire
    // on OA-B. Rules with NULL line_account_id stay global for back-compat.
    // We use replyMessage (free, no quota) when there's a message to send;
    // tag/scenario actions don't reply, they just mutate state.
    const autoRepliesQuery = friend.line_account_id
      ? db.prepare(`SELECT * FROM auto_replies WHERE is_active = 1 AND (line_account_id = ? OR line_account_id IS NULL) ORDER BY created_at ASC`).bind(friend.line_account_id)
      : db.prepare(`SELECT * FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at ASC`);
    const autoReplies = await autoRepliesQuery.all<{
      id: string;
      line_account_id: string | null;
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

      if (!isMatch) continue;

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
        } else if (rule.response_type === 'template') {
          // response_content holds the template id; resolve to message_type +
          // message_content at fire time so updates to the template show up
          // in the next reply.
          const tpl = await db
            .prepare(`SELECT message_type, message_content FROM templates WHERE id = ?`)
            .bind(rule.response_content)
            .first<{ message_type: string; message_content: string }>();
          if (tpl) {
            const message = buildMessage(tpl.message_type, tpl.message_content);
            await lineClient.replyMessage(event.replyToken, [message]);
          }
        } else if (rule.response_type === 'add_tag') {
          await addTagToFriend(db, friend.id, rule.response_content);
        } else if (rule.response_type === 'enroll_scenario') {
          await enrollFriendInScenario(db, friend.id, rule.response_content);
        }

        const outLogId = crypto.randomUUID();
        await db
          .prepare(
            `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
             VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, ?)`,
          )
          .bind(outLogId, friend.id, rule.response_type, rule.response_content, jstNow())
          .run();
      } catch (err) {
        console.error('Failed to apply auto-reply', err);
      }

      matched = true;
      break;
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

    if (action === 'enroll_scenario' || action === 'postback') {
      // Compound postback fired by Buttons-template buttons. The data may
      // include any of:
      //   action=postback (or legacy enroll_scenario)
      //   scenario_id=<uuid>     enroll into this scenario
      //   tag_ids=<csv of uuids> attach each tag
      // Effects are independent — partial failures are logged but don't
      // abort the rest.
      const scenarioId = params.get('scenario_id');
      const tagCsv = params.get('tag_ids');
      const tagIds = tagCsv ? tagCsv.split(',').filter(Boolean) : [];

      if (scenarioId) {
        const existing = await db
          .prepare(`SELECT id, status FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ? AND status = 'active'`)
          .bind(friend.id, scenarioId)
          .first<{ id: string; status: string }>();
        if (!existing) {
          try {
            await enrollFriendInScenario(db, friend.id, scenarioId);
          } catch (e) {
            console.error('postback enroll_scenario failed:', e);
          }
        }
      }

      for (const tagId of tagIds) {
        try {
          await addTagToFriend(db, friend.id, tagId);
        } catch (e) {
          console.error('postback add_tag failed:', e);
        }
      }
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
      await notifyScenarioEnrolled(discordWebhookUrl, db, friendId, scenario.id);
      const steps = await getScenarioSteps(db, scenario.id);
      const firstStep = steps[0];

      if (firstStep && firstStep.delay_minutes === 0 && friendScenario.status === 'active') {
        try {
          let immediateContent = firstStep.message_content;
          if (c.env.TRACKING_BASE_URL) {
            immediateContent = applyTrackingLinks(immediateContent, c.env.TRACKING_BASE_URL, friendId);
          }
          const message = buildMessage(firstStep.message_type, immediateContent);
          await lineClient.pushMessage(lineUserId, [message]);

          const logId = crypto.randomUUID();
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, ?)`,
            )
            .bind(logId, friendId, firstStep.message_type, immediateContent, firstStep.id, jstNow())
            .run();
          await upsertChatOnMessage(db, friendId);

          const secondStep = steps[1] ?? null;
          if (secondStep) {
            const nextDeliveryDate = new Date();
            nextDeliveryDate.setMinutes(nextDeliveryDate.getMinutes() + secondStep.delay_minutes);
            await advanceFriendScenario(db, friendScenario.id, firstStep.step_order, toJstString(nextDeliveryDate));
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
