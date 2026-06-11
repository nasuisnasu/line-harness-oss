import {
  getBroadcastById,
  getBroadcasts,
  updateBroadcastStatus,
  getFriendsByTag,
  getFriendsExcludingTag,
  getLineAccountById,
  jstNow,
} from '@line-crm/db';
import type { Broadcast } from '@line-crm/db';
import { LineClient, buttonsTemplate } from '@line-crm/line-sdk';
import type { Message, TemplateAction } from '@line-crm/line-sdk';
import { calculateStaggerDelay, sleep, addMessageVariation, addJitter } from './stealth.js';
import { applyTrackingLinks, hasTrackingLinks } from './step-delivery.js';

const MULTICAST_BATCH_SIZE = 500;

export async function processBroadcastSend(
  db: D1Database,
  lineClient: LineClient,
  broadcastId: string,
  trackingBaseUrl?: string,
): Promise<Broadcast> {
  // Mark as sending
  await updateBroadcastStatus(db, broadcastId, 'sending');

  const broadcast = await getBroadcastById(db, broadcastId);
  if (!broadcast) {
    throw new Error(`Broadcast ${broadcastId} not found`);
  }

  // Multi-message support: when broadcasts.messages_json is set, treat the
  // broadcast as an array of up to 5 messages (LINE pushMessage cap). The
  // legacy single message_type/message_content path is preserved as a
  // fallback so existing scheduled broadcasts keep working.
  const multiMessages = parseMultiMessages(broadcast as Broadcast & { messages_json?: string | null });

  // 友達ごとに個別pushが必要なケース（トラッキングリンク含む or タグ配信）
  const needsPerFriend = multiMessages
    ? multiMessages.some((m) => hasTrackingLinks(m.content))
    : hasTrackingLinks(broadcast.message_content);

  // 友達のline_account_idに紐づくアクセストークンを使う
  let client = lineClient;
  if (broadcast.line_account_id) {
    const account = await getLineAccountById(db, broadcast.line_account_id);
    if (account) client = new LineClient(account.channel_access_token);
  }

  let totalCount = 0;
  let successCount = 0;

  try {
    if (broadcast.target_type === 'all' && !needsPerFriend) {
      // Use LINE broadcast API (sends to all followers)
      const messages = multiMessages
        ? multiMessages.map((m) => buildMessage(m.type, m.content))
        : [buildMessage(broadcast.message_type, broadcast.message_content)];
      await client.broadcast(messages);
      totalCount = 0;
      successCount = 0;
    } else {
      // 個別配信ロジック
      let friends: Array<{ id: string; line_user_id: string; is_following: number; is_blocked: number }>;
      if (broadcast.target_type === 'all') {
        // 個別pushが必要なため、followers全員を取得
        const result = await db
          .prepare(`SELECT id, line_user_id, is_following, is_blocked FROM friends WHERE line_account_id = ? AND is_following = 1 AND is_blocked = 0`)
          .bind(broadcast.line_account_id)
          .all<{ id: string; line_user_id: string; is_following: number; is_blocked: number }>();
        friends = result.results;
      } else {
        // Compound filter: { include: [...], exclude: [...] } takes priority over legacy single-tag
        const filterRaw = (broadcast as { target_tag_filter_json?: string | null }).target_tag_filter_json;
        if (filterRaw) {
          const filter = JSON.parse(filterRaw) as { include?: string[]; exclude?: string[] };
          const incl = (filter.include ?? []).filter(Boolean);
          const excl = (filter.exclude ?? []).filter(Boolean);
          if (incl.length === 0 && excl.length === 0) {
            throw new Error('At least one include or exclude tag is required');
          }
          // Build dynamic SQL: friend has ALL include tags, has NONE of exclude tags
          const conds: string[] = ['f.line_account_id = ?', 'f.is_following = 1', 'f.is_blocked = 0'];
          const binds: string[] = [broadcast.line_account_id];
          for (const tagId of incl) {
            conds.push('EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)');
            binds.push(tagId);
          }
          for (const tagId of excl) {
            conds.push('NOT EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)');
            binds.push(tagId);
          }
          const sql = `SELECT f.id, f.line_user_id, f.is_following, f.is_blocked FROM friends f WHERE ${conds.join(' AND ')}`;
          const result = await db.prepare(sql).bind(...binds).all<{ id: string; line_user_id: string; is_following: number; is_blocked: number }>();
          friends = result.results;
        } else {
          if (!broadcast.target_tag_id) {
            throw new Error('target_tag_id is required for tag-targeted broadcasts');
          }
          const tagFriends = broadcast.target_tag_mode === 'exclude'
            ? await getFriendsExcludingTag(db, broadcast.target_tag_id, broadcast.line_account_id)
            : await getFriendsByTag(db, broadcast.target_tag_id);
          friends = tagFriends.filter((f) => f.is_following && !f.is_blocked);
        }
      }
      totalCount = friends.length;

      const now = jstNow();
      if (needsPerFriend) {
        // 1人ずつ個別push（トラッキングリンクのため）
        for (let i = 0; i < friends.length; i++) {
          const friend = friends[i];
          if (i > 0) await sleep(addJitter(80, 200));
          try {
            const messages: Message[] = multiMessages
              ? multiMessages.map((m) => buildMessage(m.type, applyTrackingLinks(m.content, trackingBaseUrl ?? '', friend.id)))
              : [buildMessage(broadcast.message_type, applyTrackingLinks(broadcast.message_content, trackingBaseUrl ?? '', friend.id))];
            await client.pushMessage(friend.line_user_id, messages);
            successCount++;

            // Log a single summary row regardless of how many messages were
            // sent — the multi-message body is too long to dump verbatim
            // and the broadcast_id already lets you join back to the source.
            const logId = crypto.randomUUID();
            const logType = multiMessages ? 'multi' : broadcast.message_type;
            const logContent = multiMessages ? `[${multiMessages.length} messages]` : applyTrackingLinks(broadcast.message_content, trackingBaseUrl ?? '', friend.id);
            await db
              .prepare(
                `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
                 VALUES (?, ?, 'outgoing', ?, ?, ?, NULL, ?)`,
              )
              .bind(logId, friend.id, logType, logContent, broadcastId, now)
              .run();
          } catch (err) {
            console.error(`Push to ${friend.line_user_id} failed:`, err);
          }
        }
      } else {
        // multicast（バッチ送信）
        const baseMessages: Message[] = multiMessages
          ? multiMessages.map((m) => buildMessage(m.type, m.content))
          : [buildMessage(broadcast.message_type, broadcast.message_content)];
        const totalBatches = Math.ceil(friends.length / MULTICAST_BATCH_SIZE);
        for (let i = 0; i < friends.length; i += MULTICAST_BATCH_SIZE) {
          const batchIndex = Math.floor(i / MULTICAST_BATCH_SIZE);
          const batch = friends.slice(i, i + MULTICAST_BATCH_SIZE);
          const lineUserIds = batch.map((f) => f.line_user_id);

          if (batchIndex > 0) {
            const delay = calculateStaggerDelay(friends.length, batchIndex);
            await sleep(delay);
          }

          // Apply per-batch text variation only to the first text message in
          // the bundle so we don't churn images / flex payloads.
          let batchMessages = baseMessages;
          if (totalBatches > 1) {
            batchMessages = baseMessages.map((m) => (
              m.type === 'text' ? { ...m, text: addMessageVariation(m.text, batchIndex) } : m
            ));
          }

          try {
            await client.multicast(lineUserIds, batchMessages);
            successCount += batch.length;

            for (const friend of batch) {
              const logId = crypto.randomUUID();
              const logType = multiMessages ? 'multi' : broadcast.message_type;
              const logContent = multiMessages ? `[${multiMessages.length} messages]` : broadcast.message_content;
              await db
                .prepare(
                  `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
                   VALUES (?, ?, 'outgoing', ?, ?, ?, NULL, ?)`,
                )
                .bind(logId, friend.id, logType, logContent, broadcastId, now)
                .run();
            }
          } catch (err) {
            console.error(`Multicast batch ${i / MULTICAST_BATCH_SIZE} failed:`, err);
          }
        }
      }
    }

    await updateBroadcastStatus(db, broadcastId, 'sent', { totalCount, successCount });
  } catch (err) {
    await updateBroadcastStatus(db, broadcastId, 'draft');
    throw err;
  }

  return (await getBroadcastById(db, broadcastId))!;
}

export async function processScheduledBroadcasts(
  db: D1Database,
  lineClient: LineClient,
  trackingBaseUrl?: string,
): Promise<void> {
  const allBroadcasts = await getBroadcasts(db);

  const nowMs = Date.now();
  const scheduled = allBroadcasts.filter(
    (b) =>
      b.status === 'scheduled' &&
      b.scheduled_at !== null &&
      new Date(b.scheduled_at).getTime() <= nowMs,
  );

  for (const broadcast of scheduled) {
    try {
      await processBroadcastSend(db, lineClient, broadcast.id, trackingBaseUrl);
    } catch (err) {
      console.error(`Failed to send scheduled broadcast ${broadcast.id}:`, err);
    }
  }
}

export function buildMessage(messageType: string, messageContent: string): Message {
  if (messageType === 'text') {
    return { type: 'text', text: messageContent };
  }

  if (messageType === 'image') {
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
      const parsed = JSON.parse(messageContent) as {
        thumbnailImageUrl?: string;
        title?: string;
        text: string;
        altText?: string;
        actions: TemplateAction[];
      };
      return buttonsTemplate({
        altText: parsed.altText || parsed.title || parsed.text || 'メッセージ',
        text: parsed.text,
        title: parsed.title,
        thumbnailImageUrl: parsed.thumbnailImageUrl,
        actions: parsed.actions,
      });
    } catch {
      return { type: 'text', text: messageContent };
    }
  }

  return { type: 'text', text: messageContent };
}

/**
 * Pull the multi-message array out of a broadcast row. Returns null when
 * the broadcast is single-message (legacy).
 */
export function parseMultiMessages(broadcast: { messages_json?: string | null }): { type: string; content: string }[] | null {
  if (!broadcast.messages_json) return null;
  try {
    const parsed = JSON.parse(broadcast.messages_json) as { type: string; content: string }[];
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed.slice(0, 5);
  } catch {
    return null;
  }
}
