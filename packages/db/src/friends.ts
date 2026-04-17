import { jstNow } from './utils.js';
export interface Friend {
  id: string;
  line_account_id: string | null;
  line_user_id: string;
  display_name: string | null;
  picture_url: string | null;
  status_message: string | null;
  is_following: number;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface GetFriendsOptions {
  limit?: number;
  offset?: number;
  tagId?: string;
  lineAccountId?: string | null;
}

export async function getFriends(
  db: D1Database,
  opts: GetFriendsOptions = {},
): Promise<Friend[]> {
  const { limit = 50, offset = 0, tagId, lineAccountId } = opts;

  if (tagId) {
    const accountFilter = lineAccountId !== undefined
      ? lineAccountId === null ? 'AND f.line_account_id IS NULL' : 'AND f.line_account_id = ?'
      : '';
    const binds: unknown[] = lineAccountId !== undefined && lineAccountId !== null
      ? [tagId, lineAccountId, limit, offset]
      : [tagId, limit, offset];
    const result = await db
      .prepare(
        `SELECT f.*
         FROM friends f
         INNER JOIN friend_tags ft ON ft.friend_id = f.id
         WHERE ft.tag_id = ? ${accountFilter}
         ORDER BY f.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...binds)
      .all<Friend>();
    return result.results;
  }

  if (lineAccountId !== undefined) {
    if (lineAccountId === null) {
      const result = await db
        .prepare(
          `SELECT * FROM friends
           WHERE line_account_id IS NULL
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?`,
        )
        .bind(limit, offset)
        .all<Friend>();
      return result.results;
    }
    const result = await db
      .prepare(
        `SELECT * FROM friends
         WHERE line_account_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(lineAccountId, limit, offset)
      .all<Friend>();
    return result.results;
  }

  const result = await db
    .prepare(
      `SELECT * FROM friends
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(limit, offset)
    .all<Friend>();
  return result.results;
}

export async function getFriendByLineUserId(
  db: D1Database,
  lineUserId: string,
  lineAccountId?: string | null,
): Promise<Friend | null> {
  if (lineAccountId !== undefined) {
    if (lineAccountId === null) {
      return db
        .prepare(`SELECT * FROM friends WHERE line_user_id = ? AND line_account_id IS NULL`)
        .bind(lineUserId)
        .first<Friend>();
    }
    return db
      .prepare(`SELECT * FROM friends WHERE line_user_id = ? AND line_account_id = ?`)
      .bind(lineUserId, lineAccountId)
      .first<Friend>();
  }
  return db
    .prepare(`SELECT * FROM friends WHERE line_user_id = ?`)
    .bind(lineUserId)
    .first<Friend>();
}

export async function getFriendById(
  db: D1Database,
  id: string,
): Promise<Friend | null> {
  return db
    .prepare(`SELECT * FROM friends WHERE id = ?`)
    .bind(id)
    .first<Friend>();
}

export interface UpsertFriendInput {
  lineUserId: string;
  lineAccountId?: string | null;
  displayName?: string | null;
  pictureUrl?: string | null;
  statusMessage?: string | null;
}

export async function upsertFriend(
  db: D1Database,
  input: UpsertFriendInput,
): Promise<Friend> {
  const now = jstNow();
  const existing = await getFriendByLineUserId(db, input.lineUserId, input.lineAccountId);

  if (existing) {
    const whereClause = input.lineAccountId !== undefined
      ? input.lineAccountId === null
        ? 'WHERE line_user_id = ? AND line_account_id IS NULL'
        : 'WHERE line_user_id = ? AND line_account_id = ?'
      : 'WHERE line_user_id = ?';
    const whereBinds: unknown[] = input.lineAccountId !== undefined && input.lineAccountId !== null
      ? [input.lineUserId, input.lineAccountId]
      : [input.lineUserId];

    await db
      .prepare(
        `UPDATE friends
         SET display_name = ?,
             picture_url = ?,
             status_message = ?,
             is_following = 1,
             updated_at = ?
         ${whereClause}`,
      )
      .bind(
        'displayName' in input ? (input.displayName ?? null) : existing.display_name,
        'pictureUrl' in input ? (input.pictureUrl ?? null) : existing.picture_url,
        'statusMessage' in input ? (input.statusMessage ?? null) : existing.status_message,
        now,
        ...whereBinds,
      )
      .run();

    return (await getFriendByLineUserId(db, input.lineUserId, input.lineAccountId))!;
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO friends (id, line_account_id, line_user_id, display_name, picture_url, status_message, is_following, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(
      id,
      input.lineAccountId ?? null,
      input.lineUserId,
      input.displayName ?? null,
      input.pictureUrl ?? null,
      input.statusMessage ?? null,
      now,
      now,
    )
    .run();

  return (await getFriendById(db, id))!;
}

export async function updateFriendFollowStatus(
  db: D1Database,
  lineUserId: string,
  isFollowing: boolean,
  lineAccountId?: string | null,
): Promise<void> {
  if (lineAccountId !== undefined) {
    const whereClause = lineAccountId === null
      ? 'WHERE line_user_id = ? AND line_account_id IS NULL'
      : 'WHERE line_user_id = ? AND line_account_id = ?';
    const binds: unknown[] = lineAccountId === null
      ? [isFollowing ? 1 : 0, jstNow(), lineUserId]
      : [isFollowing ? 1 : 0, jstNow(), lineUserId, lineAccountId];
    await db
      .prepare(`UPDATE friends SET is_following = ?, updated_at = ? ${whereClause}`)
      .bind(...binds)
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE friends
       SET is_following = ?, updated_at = ?
       WHERE line_user_id = ?`,
    )
    .bind(isFollowing ? 1 : 0, jstNow(), lineUserId)
    .run();
}

export async function getFriendCount(
  db: D1Database,
  lineAccountId?: string | null,
): Promise<number> {
  if (lineAccountId !== undefined) {
    if (lineAccountId === null) {
      const row = await db
        .prepare(`SELECT COUNT(*) as count FROM friends WHERE line_account_id IS NULL`)
        .first<{ count: number }>();
      return row?.count ?? 0;
    }
    const row = await db
      .prepare(`SELECT COUNT(*) as count FROM friends WHERE line_account_id = ?`)
      .bind(lineAccountId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }
  const row = await db
    .prepare(`SELECT COUNT(*) as count FROM friends`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
