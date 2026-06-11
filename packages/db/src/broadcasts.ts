import { jstNow } from './utils.js';
export type BroadcastTargetType = 'all' | 'tag';
export type BroadcastTargetTagMode = 'include' | 'exclude';
export type BroadcastStatus = 'draft' | 'scheduled' | 'sending' | 'sent';
export type BroadcastMessageType = 'text' | 'image' | 'flex';

export interface Broadcast {
  id: string;
  line_account_id: string | null;
  title: string;
  message_type: BroadcastMessageType;
  message_content: string;
  /** JSON-encoded array of {type, content} for multi-message broadcasts.
   *  When present, it overrides message_type/message_content at send time. */
  messages_json: string | null;
  target_type: BroadcastTargetType;
  target_tag_id: string | null;
  target_tag_mode: BroadcastTargetTagMode;
  /** JSON: { include: string[], exclude: string[] } — compound tag filter.
   *  When present, takes priority over target_tag_id / target_tag_mode. */
  target_tag_filter_json: string | null;
  status: BroadcastStatus;
  scheduled_at: string | null;
  sent_at: string | null;
  total_count: number;
  success_count: number;
  group_name: string | null;
  created_at: string;
}

export async function getBroadcasts(db: D1Database, lineAccountId?: string): Promise<Broadcast[]> {
  if (lineAccountId) {
    const result = await db
      .prepare(`SELECT * FROM broadcasts WHERE line_account_id = ? ORDER BY created_at DESC`)
      .bind(lineAccountId)
      .all<Broadcast>();
    return result.results;
  }
  const result = await db
    .prepare(`SELECT * FROM broadcasts ORDER BY created_at DESC`)
    .all<Broadcast>();
  return result.results;
}

export async function getBroadcastById(
  db: D1Database,
  id: string,
): Promise<Broadcast | null> {
  return db
    .prepare(`SELECT * FROM broadcasts WHERE id = ?`)
    .bind(id)
    .first<Broadcast>();
}

export interface CreateBroadcastInput {
  title: string;
  messageType: BroadcastMessageType;
  messageContent: string;
  /** Optional multi-message bundle (1-5). When set, the worker uses this
   *  instead of messageType/messageContent at send time. */
  messages?: { type: string; content: string }[];
  targetType: BroadcastTargetType;
  targetTagId?: string | null;
  targetTagMode?: BroadcastTargetTagMode;
  /** Compound tag filter: { include: [], exclude: [] }. Takes priority over targetTagId. */
  targetTagFilter?: { include?: string[]; exclude?: string[] } | null;
  scheduledAt?: string | null;
  lineAccountId?: string | null;
  groupName?: string | null;
}

export async function createBroadcast(
  db: D1Database,
  input: CreateBroadcastInput,
): Promise<Broadcast> {
  const id = crypto.randomUUID();
  const now = jstNow();

  const initialStatus: BroadcastStatus = input.scheduledAt ? 'scheduled' : 'draft';
  const messagesJson = input.messages && input.messages.length > 0
    ? JSON.stringify(input.messages.slice(0, 5))
    : null;

  const tagFilterJson = input.targetTagFilter
    ? JSON.stringify({
        include: input.targetTagFilter.include ?? [],
        exclude: input.targetTagFilter.exclude ?? [],
      })
    : null;

  await db
    .prepare(
      `INSERT INTO broadcasts
         (id, line_account_id, title, message_type, message_content, messages_json, target_type, target_tag_id, target_tag_mode, target_tag_filter_json, status, scheduled_at, sent_at, total_count, success_count, group_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, ?, ?)`,
    )
    .bind(
      id,
      input.lineAccountId ?? null,
      input.title,
      input.messageType,
      input.messageContent,
      messagesJson,
      input.targetType,
      input.targetTagId ?? null,
      input.targetTagMode ?? 'include',
      tagFilterJson,
      initialStatus,
      input.scheduledAt ?? null,
      input.groupName ?? null,
      now,
    )
    .run();

  return (await getBroadcastById(db, id))!;
}

export type UpdateBroadcastInput = Partial<
  Pick<
    Broadcast,
    | 'title'
    | 'message_type'
    | 'message_content'
    | 'messages_json'
    | 'target_type'
    | 'target_tag_id'
    | 'target_tag_mode'
    | 'target_tag_filter_json'
    | 'status'
    | 'scheduled_at'
    | 'group_name'
  >
>;

export async function updateBroadcast(
  db: D1Database,
  id: string,
  updates: UpdateBroadcastInput,
): Promise<Broadcast | null> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.message_type !== undefined) {
    fields.push('message_type = ?');
    values.push(updates.message_type);
  }
  if (updates.message_content !== undefined) {
    fields.push('message_content = ?');
    values.push(updates.message_content);
  }
  if (updates.messages_json !== undefined) {
    fields.push('messages_json = ?');
    values.push(updates.messages_json);
  }
  if (updates.target_type !== undefined) {
    fields.push('target_type = ?');
    values.push(updates.target_type);
  }
  if (updates.target_tag_id !== undefined) {
    fields.push('target_tag_id = ?');
    values.push(updates.target_tag_id);
  }
  if (updates.target_tag_mode !== undefined) {
    fields.push('target_tag_mode = ?');
    values.push(updates.target_tag_mode);
  }
  if (updates.target_tag_filter_json !== undefined) {
    fields.push('target_tag_filter_json = ?');
    values.push(updates.target_tag_filter_json);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.scheduled_at !== undefined) {
    fields.push('scheduled_at = ?');
    values.push(updates.scheduled_at);
  }
  if (updates.group_name !== undefined) {
    fields.push('group_name = ?');
    values.push(updates.group_name);
  }

  if (fields.length > 0) {
    values.push(id);
    await db
      .prepare(`UPDATE broadcasts SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  return getBroadcastById(db, id);
}

export async function deleteBroadcast(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM broadcasts WHERE id = ?`).bind(id).run();
}

export interface BroadcastStatusCounts {
  totalCount?: number;
  successCount?: number;
}

export async function updateBroadcastStatus(
  db: D1Database,
  id: string,
  status: BroadcastStatus,
  counts?: BroadcastStatusCounts,
): Promise<void> {
  const fields: string[] = ['status = ?'];
  const values: unknown[] = [status];

  if (status === 'sent') {
    fields.push('sent_at = ?');
    values.push(jstNow());
  }
  if (counts?.totalCount !== undefined) {
    fields.push('total_count = ?');
    values.push(counts.totalCount);
  }
  if (counts?.successCount !== undefined) {
    fields.push('success_count = ?');
    values.push(counts.successCount);
  }

  values.push(id);
  await db
    .prepare(`UPDATE broadcasts SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
}
