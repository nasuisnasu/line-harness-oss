import {
  getFriendScenariosDueForDelivery,
  getScenarioSteps,
  advanceFriendScenario,
  completeFriendScenario,
  computeStepNextDeliveryAt,
  getFriendById,
  getLineAccountById,
  getRichMenuById,
  jstNow,
} from '@line-crm/db';
import { LineClient, buttonsTemplate } from '@line-crm/line-sdk';
import type { Message, TemplateAction } from '@line-crm/line-sdk';

export async function processStepDeliveries(
  db: D1Database,
  lineClient: LineClient,
  trackingBaseUrl?: string,
): Promise<void> {
  const now = jstNow();
  const dueFriendScenarios = await getFriendScenariosDueForDelivery(db, now);

  for (const fs of dueFriendScenarios) {
    try {
      await processSingleDelivery(db, lineClient, fs, trackingBaseUrl);
    } catch (err) {
      console.error(`Error processing friend_scenario ${fs.id}:`, err);
      // Continue with next one
    }
  }
}

async function processSingleDelivery(
  db: D1Database,
  lineClient: LineClient,
  fs: {
    id: string;
    friend_id: string;
    scenario_id: string;
    current_step_order: number;
    status: string;
    next_delivery_at: string | null;
  },
  trackingBaseUrl?: string,
): Promise<void> {
  // Get all steps for this scenario
  const steps = await getScenarioSteps(db, fs.scenario_id);
  if (steps.length === 0) {
    await completeFriendScenario(db, fs.id);
    return;
  }

  // Steps are sorted by step_order but may not be contiguous (e.g., 1, 3, 5 after deletions).
  // Find the next step whose step_order > current_step_order.
  const currentStep = steps.find((s) => s.step_order > fs.current_step_order);

  if (!currentStep) {
    // No more steps — scenario is complete
    await completeFriendScenario(db, fs.id);
    return;
  }

  // Check step condition before sending
  if (currentStep.condition_type) {
    const conditionMet = await evaluateCondition(db, fs.friend_id, currentStep);
    if (!conditionMet) {
      if (currentStep.next_step_on_false !== null && currentStep.next_step_on_false !== undefined) {
        // Jump to the specified step_order on failure
        const jumpStep = steps.find((s) => s.step_order === currentStep.next_step_on_false);
        if (jumpStep) {
          await advanceFriendScenario(db, fs.id, currentStep.step_order, computeStepNextDeliveryAt(jumpStep));
          return;
        }
      }
      // No jump target — skip this step and advance to next sequential
      const nextIndex = steps.indexOf(currentStep) + 1;
      if (nextIndex < steps.length) {
        const nextStep = steps[nextIndex];
        await advanceFriendScenario(db, fs.id, currentStep.step_order, computeStepNextDeliveryAt(nextStep));
      } else {
        await completeFriendScenario(db, fs.id);
      }
      return;
    }
  }

  // Get friend's LINE user ID
  const friend = await getFriendById(db, fs.friend_id);
  if (!friend || !friend.is_following || friend.is_blocked) {
    // Friend unfollowed, not found, or blocked from all deliveries — complete the scenario
    await completeFriendScenario(db, fs.id);
    return;
  }

  // Use per-account LINE client if friend belongs to a specific account
  let client = lineClient;
  if (friend.line_account_id) {
    const account = await getLineAccountById(db, friend.line_account_id);
    if (account) client = new LineClient(account.channel_access_token);
  }

  // メッセージタイプが 'richmenu' なら、メッセージ送信せずリッチメニューをLink/Unlinkして次へ
  if (currentStep.message_type === 'richmenu') {
    try {
      if (currentStep.rich_menu_id) {
        const rm = await getRichMenuById(db, currentStep.rich_menu_id);
        if (rm?.line_richmenu_id) {
          await client.linkRichMenuToUser(friend.line_user_id, rm.line_richmenu_id);
        }
      } else {
        // rich_menu_id が空ならアンリンク
        await client.unlinkRichMenuFromUser(friend.line_user_id);
      }
    } catch (e) {
      console.error('Rich menu switch error:', e);
    }
    // ログだけ残して次のステップへ
    const logId = crypto.randomUUID();
    const now = jstNow();
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
         VALUES (?, ?, 'outgoing', 'richmenu', ?, NULL, ?, ?)`,
      )
      .bind(logId, friend.id, currentStep.rich_menu_id ?? '', currentStep.id, now)
      .run();
    await advanceFriendScenario(db, fs.id, currentStep.step_order, null);
    return;
  }

  // Collect a "burst" of consecutive immediate push-type steps so they all
  // arrive in a single LINE pushMessage call (LINE supports up to 5 messages
  // per push and renders them as a single grouped delivery). Without this,
  // step 1 → step 2 with delay_minutes=0 still landed with a small visible
  // gap because each step issued its own API call.
  const currentIndex = steps.indexOf(currentStep);
  const batch = [currentStep];
  let cursor = currentIndex + 1;
  while (cursor < steps.length && batch.length < 5) {
    const candidate = steps[cursor];
    const candidateImmediate =
      candidate.delay_mode === 'relative' &&
      (candidate.delay_minutes ?? 0) === 0 &&
      (candidate.delay_days ?? 0) === 0;
    if (!candidateImmediate) break;
    // richmenu / conditional steps need their own logic (link/unlink, eval),
    // so the batch ends just before them.
    if (candidate.message_type === 'richmenu') break;
    if (candidate.condition_type) break;
    batch.push(candidate);
    cursor++;
  }

  // Build all messages in the burst, applying var substitution + tracking link
  // rewrites per-step.
  const messages = batch.map((step) => {
    let content = applyVars(step.message_content, { name: friend.display_name ?? '', friendId: friend.id });
    if (trackingBaseUrl) {
      content = applyTrackingLinks(content, trackingBaseUrl, friend.id);
    }
    return buildMessage(step.message_type, content);
  });
  await client.pushMessage(friend.line_user_id, messages);

  // Log every step in the burst as outgoing.
  const now = jstNow();
  for (const step of batch) {
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, ?)`,
      )
      .bind(crypto.randomUUID(), friend.id, step.message_type, step.message_content, step.id, now)
      .run();
  }

  // Ensure chat room exists and is up-to-date (single update for the burst).
  const existing = await db.prepare(`SELECT id FROM chats WHERE friend_id = ?`).bind(friend.id).first<{ id: string }>();
  if (existing) {
    await db.prepare(`UPDATE chats SET last_message_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, existing.id).run();
  } else {
    await db.prepare(`INSERT INTO chats (id, friend_id, status, last_message_at, created_at, updated_at) VALUES (?, ?, 'unread', ?, ?, ?)`)
      .bind(crypto.randomUUID(), friend.id, now, now, now).run();
  }

  const lastStep = batch[batch.length - 1];
  const afterLast = cursor < steps.length ? steps[cursor] : null;

  if (afterLast) {
    const nextDeliveryStr = computeStepNextDeliveryAt(afterLast);
    await advanceFriendScenario(db, fs.id, lastStep.step_order, nextDeliveryStr);

    // If the next step is also immediate but couldn't join the batch (richmenu
    // / conditional), recurse so it doesn't wait for the next cron tick.
    const afterLastImmediate =
      afterLast.delay_mode === 'relative' &&
      (afterLast.delay_minutes ?? 0) === 0 &&
      (afterLast.delay_days ?? 0) === 0;
    if (afterLastImmediate) {
      await processSingleDelivery(
        db,
        client,
        {
          ...fs,
          current_step_order: lastStep.step_order,
          next_delivery_at: nextDeliveryStr,
        },
        trackingBaseUrl,
      );
    }
  } else {
    await completeFriendScenario(db, fs.id);
  }
}

async function evaluateCondition(
  db: D1Database,
  friendId: string,
  step: { condition_type: string | null; condition_value: string | null },
): Promise<boolean> {
  if (!step.condition_type || !step.condition_value) return true;

  switch (step.condition_type) {
    case 'tag_exists': {
      const tag = await db
        .prepare('SELECT 1 FROM friend_tags WHERE friend_id = ? AND tag_id = ?')
        .bind(friendId, step.condition_value)
        .first();
      return !!tag;
    }
    case 'tag_not_exists': {
      const tag = await db
        .prepare('SELECT 1 FROM friend_tags WHERE friend_id = ? AND tag_id = ?')
        .bind(friendId, step.condition_value)
        .first();
      return !tag;
    }
    case 'metadata_equals': {
      const { key, value } = JSON.parse(step.condition_value) as { key: string; value: unknown };
      const friend = await db
        .prepare('SELECT metadata FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ metadata: string }>();
      const metadata = JSON.parse(friend?.metadata || '{}') as Record<string, unknown>;
      return metadata[key] === value;
    }
    case 'metadata_not_equals': {
      const { key, value } = JSON.parse(step.condition_value) as { key: string; value: unknown };
      const friend = await db
        .prepare('SELECT metadata FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ metadata: string }>();
      const metadata = JSON.parse(friend?.metadata || '{}') as Record<string, unknown>;
      return metadata[key] !== value;
    }
    default:
      return true;
  }
}

export function applyVars(content: string, vars: Record<string, string>): string {
  return content.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

/**
 * メッセージ内の {link:linkId} を per-friend のトラッキングURLに置換する。
 * baseUrl 例: https://line-crm-worker.readash-crm.workers.dev
 * friendId が null の場合は ?f= を付けない（合計クリック数のみカウントされる）。
 */
export function applyTrackingLinks(
  content: string,
  baseUrl: string,
  friendId: string | null,
): string {
  return content.replace(/\{link:([a-zA-Z0-9-]+)\}/g, (_, linkId: string) => {
    return friendId
      ? `${baseUrl}/t/${linkId}?f=${friendId}`
      : `${baseUrl}/t/${linkId}`;
  });
}

/** メッセージ内に {link:xxx} が含まれるかどうか */
export function hasTrackingLinks(content: string): boolean {
  return /\{link:[a-zA-Z0-9-]+\}/.test(content);
}

export function buildMessage(messageType: string, messageContent: string): Message {
  if (messageType === 'text') {
    return { type: 'text', text: messageContent };
  }

  if (messageType === 'image') {
    // messageContent is expected to be JSON: { originalContentUrl, previewImageUrl }
    try {
      const parsed = JSON.parse(messageContent) as {
        originalContentUrl: string;
        previewImageUrl: string;
      };
      return {
        type: 'image',
        originalContentUrl: parsed.originalContentUrl,
        previewImageUrl: parsed.previewImageUrl,
      };
    } catch {
      // Fallback: treat as text if parsing fails
      return { type: 'text', text: messageContent };
    }
  }

  if (messageType === 'flex') {
    try {
      const contents = JSON.parse(messageContent);
      return { type: 'flex', altText: 'Message', contents };
    } catch {
      return { type: 'text', text: messageContent };
    }
  }

  if (messageType === 'buttons') {
    try {
      const parsed = JSON.parse(messageContent) as ButtonsTemplateContent;
      return buttonsTemplate({
        altText: parsed.altText || parsed.title || parsed.text || 'メッセージ',
        text: parsed.text,
        title: parsed.title,
        thumbnailImageUrl: parsed.thumbnailImageUrl,
        actions: parsed.actions as TemplateAction[],
      });
    } catch {
      return { type: 'text', text: messageContent };
    }
  }

  // Fallback
  return { type: 'text', text: messageContent };
}

interface ButtonsTemplateContent {
  thumbnailImageUrl?: string;
  title?: string;
  text: string;
  altText?: string;
  actions: Array<
    | { type: 'message'; label: string; text: string }
    | { type: 'uri'; label: string; uri: string }
    | { type: 'postback'; label: string; data: string; displayText?: string }
  >;
}
