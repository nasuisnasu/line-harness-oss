import { jstNow } from './utils.js';
export interface Tag {
  id: string;
  line_account_id: string | null;
  name: string;
  color: string;
  group_name: string | null;
  sort_order: number;
  created_at: string;
}

export interface FriendTag {
  friend_id: string;
  tag_id: string;
  assigned_at: string;
}

export async function getTags(db: D1Database, lineAccountId?: string): Promise<Tag[]> {
  if (lineAccountId) {
    const result = await db
      .prepare(`SELECT * FROM tags WHERE line_account_id = ? ORDER BY sort_order ASC, name ASC`)
      .bind(lineAccountId)
      .all<Tag>();
    return result.results;
  }
  const result = await db
    .prepare(`SELECT * FROM tags ORDER BY sort_order ASC, name ASC`)
    .all<Tag>();
  return result.results;
}

/** 渡された順に sort_order を 0,1,2... で振り直す。並び替え用。 */
export async function reorderTags(db: D1Database, orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return;
  const stmts = orderedIds.map((id, i) =>
    db.prepare(`UPDATE tags SET sort_order = ? WHERE id = ?`).bind(i, id),
  );
  await db.batch(stmts);
}

export interface CreateTagInput {
  name: string;
  color?: string;
  groupName?: string | null;
  lineAccountId?: string | null;
}

export async function createTag(
  db: D1Database,
  input: CreateTagInput,
): Promise<Tag> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const color = input.color ?? '#3B82F6';
  // 末尾に追加されるよう、現在の最大 sort_order + 1 を採番。
  const maxRow = await db
    .prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM tags`)
    .first<{ m: number }>();
  const sortOrder = (maxRow?.m ?? -1) + 1;

  await db
    .prepare(
      `INSERT INTO tags (id, line_account_id, name, color, group_name, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.lineAccountId ?? null, input.name, color, input.groupName ?? null, sortOrder, now)
    .run();

  return (await db
    .prepare(`SELECT * FROM tags WHERE id = ?`)
    .bind(id)
    .first<Tag>())!;
}

export async function updateTag(
  db: D1Database,
  id: string,
  input: { name?: string; color?: string; groupName?: string | null },
): Promise<Tag | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (input.name !== undefined) { sets.push('name = ?'); binds.push(input.name); }
  if (input.color !== undefined) { sets.push('color = ?'); binds.push(input.color); }
  // Use 'in' check so that explicitly clearing the group (groupName: null) sticks.
  if ('groupName' in input) { sets.push('group_name = ?'); binds.push(input.groupName ?? null); }
  if (sets.length === 0) return db.prepare(`SELECT * FROM tags WHERE id = ?`).bind(id).first<Tag>();
  binds.push(id);
  await db.prepare(`UPDATE tags SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return db.prepare(`SELECT * FROM tags WHERE id = ?`).bind(id).first<Tag>();
}

export async function deleteTag(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM tags WHERE id = ?`).bind(id).run();
}

export async function addTagToFriend(
  db: D1Database,
  friendId: string,
  tagId: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at)
       VALUES (?, ?, ?)`,
    )
    .bind(friendId, tagId, now)
    .run();
}

export async function removeTagFromFriend(
  db: D1Database,
  friendId: string,
  tagId: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ?`,
    )
    .bind(friendId, tagId)
    .run();
}

export async function getFriendTags(
  db: D1Database,
  friendId: string,
  lineAccountId?: string,
): Promise<Tag[]> {
  if (lineAccountId) {
    const result = await db
      .prepare(
        `SELECT t.*
         FROM tags t
         INNER JOIN friend_tags ft ON ft.tag_id = t.id
         WHERE ft.friend_id = ? AND t.line_account_id = ?
         ORDER BY t.name ASC`,
      )
      .bind(friendId, lineAccountId)
      .all<Tag>();
    return result.results;
  }
  const result = await db
    .prepare(
      `SELECT t.*
       FROM tags t
       INNER JOIN friend_tags ft ON ft.tag_id = t.id
       WHERE ft.friend_id = ?
       ORDER BY t.name ASC`,
    )
    .bind(friendId)
    .all<Tag>();
  return result.results;
}

import type { Friend } from './friends';

export async function getFriendsByTag(
  db: D1Database,
  tagId: string,
): Promise<Friend[]> {
  const result = await db
    .prepare(
      `SELECT f.*
       FROM friends f
       INNER JOIN friend_tags ft ON ft.friend_id = f.id
       WHERE ft.tag_id = ?
       ORDER BY f.created_at DESC`,
    )
    .bind(tagId)
    .all<Friend>();
  return result.results;
}

/** 指定タグを持たない友達を返す。lineAccountId が指定されていればそのアカウントの友達のみ。 */
export async function getFriendsExcludingTag(
  db: D1Database,
  tagId: string,
  lineAccountId?: string | null,
): Promise<Friend[]> {
  const baseSql = `SELECT f.* FROM friends f
       WHERE NOT EXISTS (
         SELECT 1 FROM friend_tags ft
         WHERE ft.friend_id = f.id AND ft.tag_id = ?
       )`;

  if (lineAccountId === null || lineAccountId === undefined) {
    const result = await db
      .prepare(`${baseSql} ORDER BY f.created_at DESC`)
      .bind(tagId)
      .all<Friend>();
    return result.results;
  }

  const result = await db
    .prepare(`${baseSql} AND f.line_account_id = ? ORDER BY f.created_at DESC`)
    .bind(tagId, lineAccountId)
    .all<Friend>();
  return result.results;
}
