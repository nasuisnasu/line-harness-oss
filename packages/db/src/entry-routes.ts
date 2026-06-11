import { jstNow } from './utils.js';
export interface EntryRoute {
  id: string;
  ref_code: string;
  name: string;
  tag_id: string | null;
  scenario_id: string | null;
  redirect_url: string | null;
  is_active: number;
  line_account_id: string | null;
  /** Free-form group label for UI bucketing (e.g. "Threads", "LP", "広告").
   *  NULL = 未分類. Operator-controlled, no fixed enum. */
  group_name: string | null;
  created_at: string;
  updated_at: string;
}

/** EntryRouteに紐づく自動付与タグID一覧（中間テーブル経由） */
export interface EntryRouteWithTags extends EntryRoute {
  tag_ids: string[];
}

export interface RefTracking {
  id: string;
  ref_code: string;
  friend_id: string | null;
  entry_route_id: string | null;
  source_url: string | null;
  created_at: string;
}

export interface CreateEntryRouteInput {
  refCode: string;
  name: string;
  tagId?: string | null;
  /** 自動付与タグID一覧（複数対応）。指定すると tagId は無視 */
  tagIds?: string[];
  scenarioId?: string | null;
  redirectUrl?: string | null;
  isActive?: boolean;
  lineAccountId?: string | null;
  /** UI grouping label. NULL/undefined → 未分類. */
  groupName?: string | null;
}

/** 中間テーブルからtag_id配列を取得 */
async function fetchEntryRouteTagIds(db: D1Database, entryRouteId: string): Promise<string[]> {
  const res = await db
    .prepare(`SELECT tag_id FROM entry_route_tags WHERE entry_route_id = ?`)
    .bind(entryRouteId)
    .all<{ tag_id: string }>();
  return res.results.map((r) => r.tag_id);
}

/** 中間テーブルを丸ごと置き換える */
async function replaceEntryRouteTags(db: D1Database, entryRouteId: string, tagIds: string[]): Promise<void> {
  await db.prepare(`DELETE FROM entry_route_tags WHERE entry_route_id = ?`).bind(entryRouteId).run();
  if (tagIds.length === 0) return;
  const now = jstNow();
  const stmts = tagIds.map((tagId) =>
    db
      .prepare(`INSERT INTO entry_route_tags (entry_route_id, tag_id, created_at) VALUES (?, ?, ?)`)
      .bind(entryRouteId, tagId, now),
  );
  await db.batch(stmts);
}

/** entry_routeに紐づく全タグID（旧tag_id + 中間テーブル）を返す */
export async function getEntryRouteTagIds(db: D1Database, entryRoute: EntryRoute): Promise<string[]> {
  const tagIds = await fetchEntryRouteTagIds(db, entryRoute.id);
  // 後方互換：旧 tag_id カラムも含める（重複は除く）
  if (entryRoute.tag_id && !tagIds.includes(entryRoute.tag_id)) {
    tagIds.push(entryRoute.tag_id);
  }
  return tagIds;
}

export async function getEntryRoutes(db: D1Database): Promise<EntryRoute[]> {
  const result = await db
    .prepare(`SELECT * FROM entry_routes ORDER BY created_at DESC`)
    .all<EntryRoute>();
  return result.results;
}

export async function getEntryRouteByRefCode(
  db: D1Database,
  refCode: string,
): Promise<EntryRoute | null> {
  return db
    .prepare(`SELECT * FROM entry_routes WHERE ref_code = ? AND is_active = 1`)
    .bind(refCode)
    .first<EntryRoute>();
}

export async function createEntryRoute(
  db: D1Database,
  input: CreateEntryRouteInput,
): Promise<EntryRoute> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const isActive = input.isActive !== false ? 1 : 0;

  await db
    .prepare(
      `INSERT INTO entry_routes
         (id, ref_code, name, tag_id, scenario_id, redirect_url, is_active, line_account_id, group_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.refCode,
      input.name,
      input.tagId ?? null,
      input.scenarioId ?? null,
      input.redirectUrl ?? null,
      isActive,
      input.lineAccountId ?? null,
      input.groupName ?? null,
      now,
      now,
    )
    .run();

  // 複数タグの紐付け
  if (input.tagIds && input.tagIds.length > 0) {
    await replaceEntryRouteTags(db, id, input.tagIds);
  }

  return (await db
    .prepare(`SELECT * FROM entry_routes WHERE id = ?`)
    .bind(id)
    .first<EntryRoute>())!;
}

export async function updateEntryRoute(
  db: D1Database,
  id: string,
  input: Partial<CreateEntryRouteInput>,
): Promise<EntryRoute | null> {
  const now = jstNow();
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (input.name !== undefined) { fields.push('name = ?'); values.push(input.name); }
  if (input.refCode !== undefined) { fields.push('ref_code = ?'); values.push(input.refCode); }
  if (input.tagId !== undefined) { fields.push('tag_id = ?'); values.push(input.tagId ?? null); }
  if (input.scenarioId !== undefined) { fields.push('scenario_id = ?'); values.push(input.scenarioId ?? null); }
  if (input.redirectUrl !== undefined) { fields.push('redirect_url = ?'); values.push(input.redirectUrl ?? null); }
  if (input.isActive !== undefined) { fields.push('is_active = ?'); values.push(input.isActive ? 1 : 0); }
  if (input.groupName !== undefined) { fields.push('group_name = ?'); values.push(input.groupName ?? null); }

  values.push(id);

  await db
    .prepare(`UPDATE entry_routes SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  // 複数タグが指定されていれば置換
  if (input.tagIds !== undefined) {
    await replaceEntryRouteTags(db, id, input.tagIds);
  }

  return db
    .prepare(`SELECT * FROM entry_routes WHERE id = ?`)
    .bind(id)
    .first<EntryRoute>();
}

export async function deleteEntryRoute(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM entry_routes WHERE id = ?`).bind(id).run();
}

export async function recordRefTracking(
  db: D1Database,
  opts: {
    refCode: string;
    friendId?: string | null;
    entryRouteId?: string | null;
    sourceUrl?: string | null;
  },
): Promise<RefTracking> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO ref_tracking (id, ref_code, friend_id, entry_route_id, source_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      opts.refCode,
      opts.friendId ?? null,
      opts.entryRouteId ?? null,
      opts.sourceUrl ?? null,
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM ref_tracking WHERE id = ?`)
    .bind(id)
    .first<RefTracking>())!;
}

export async function getRefTrackingByFriend(
  db: D1Database,
  friendId: string,
): Promise<RefTracking[]> {
  const result = await db
    .prepare(`SELECT * FROM ref_tracking WHERE friend_id = ? ORDER BY created_at DESC`)
    .bind(friendId)
    .all<RefTracking>();
  return result.results;
}

export async function getRefTrackingStats(
  db: D1Database,
  refCode: string,
): Promise<{ ref_code: string; count: number }> {
  const row = await db
    .prepare(
      `SELECT ref_code, COUNT(*) as count FROM ref_tracking WHERE ref_code = ? GROUP BY ref_code`,
    )
    .bind(refCode)
    .first<{ ref_code: string; count: number }>();
  return row ?? { ref_code: refCode, count: 0 };
}
