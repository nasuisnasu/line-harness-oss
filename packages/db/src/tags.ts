import { jstNow } from './utils.js';
export interface Tag {
  id: string;
  line_account_id: string | null;
  name: string;
  color: string;
  group_name: string | null;
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
      .prepare(`SELECT * FROM tags WHERE line_account_id = ? ORDER BY name ASC`)
      .bind(lineAccountId)
      .all<Tag>();
    return result.results;
  }
  const result = await db
    .prepare(`SELECT * FROM tags ORDER BY name ASC`)
    .all<Tag>();
  return result.results;
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

  await db
    .prepare(
      `INSERT INTO tags (id, line_account_id, name, color, group_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.lineAccountId ?? null, input.name, color, input.groupName ?? null, now)
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
