import { jstNow } from './utils.js';
// =============================================================================
// Tracked Links — URL click tracking with automatic actions
// =============================================================================

export interface TrackedLink {
  id: string;
  name: string;
  original_url: string;
  tag_id: string | null;
  scenario_id: string | null;
  is_active: number;
  click_count: number;
  /** Which LINE Official Account this link belongs to. NULL = legacy /
   *  shared (visible from any account view). */
  line_account_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface LinkClick {
  id: string;
  tracked_link_id: string;
  friend_id: string | null;
  clicked_at: string;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function getTrackedLinks(
  db: D1Database,
  options: { lineAccountId?: string | null } = {},
): Promise<TrackedLink[]> {
  // Strict per-account scoping. Legacy rows (line_account_id IS NULL) only
  // surface when the caller asks for *all* accounts (no filter), so they can
  // be triaged and assigned without polluting per-account views.
  if (options.lineAccountId) {
    const result = await db
      .prepare(
        `SELECT * FROM tracked_links
         WHERE line_account_id = ?
         ORDER BY created_at DESC`,
      )
      .bind(options.lineAccountId)
      .all<TrackedLink>();
    return result.results;
  }
  const result = await db
    .prepare(`SELECT * FROM tracked_links ORDER BY created_at DESC`)
    .all<TrackedLink>();
  return result.results;
}

export async function getTrackedLinkById(
  db: D1Database,
  id: string,
): Promise<TrackedLink | null> {
  return db
    .prepare(`SELECT * FROM tracked_links WHERE id = ?`)
    .bind(id)
    .first<TrackedLink>();
}

export interface CreateTrackedLinkInput {
  name: string;
  originalUrl: string;
  tagId?: string | null;
  scenarioId?: string | null;
  lineAccountId?: string | null;
}

export async function createTrackedLink(
  db: D1Database,
  input: CreateTrackedLinkInput,
): Promise<TrackedLink> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO tracked_links (id, name, original_url, tag_id, scenario_id, line_account_id, is_active, click_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    )
    .bind(id, input.name, input.originalUrl, input.tagId ?? null, input.scenarioId ?? null, input.lineAccountId ?? null, now, now)
    .run();

  return (await getTrackedLinkById(db, id))!;
}

export async function deleteTrackedLink(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM tracked_links WHERE id = ?`).bind(id).run();
}

export interface UpdateTrackedLinkInput {
  name?: string;
  originalUrl?: string;
  tagId?: string | null;
  scenarioId?: string | null;
  isActive?: boolean;
  lineAccountId?: string | null;
}

export async function updateTrackedLink(
  db: D1Database,
  id: string,
  input: UpdateTrackedLinkInput,
): Promise<TrackedLink | null> {
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [jstNow()];

  if (input.name !== undefined) { fields.push('name = ?'); values.push(input.name); }
  if (input.originalUrl !== undefined) { fields.push('original_url = ?'); values.push(input.originalUrl); }
  if (input.tagId !== undefined) { fields.push('tag_id = ?'); values.push(input.tagId ?? null); }
  if (input.scenarioId !== undefined) { fields.push('scenario_id = ?'); values.push(input.scenarioId ?? null); }
  if (input.isActive !== undefined) { fields.push('is_active = ?'); values.push(input.isActive ? 1 : 0); }
  if (input.lineAccountId !== undefined) { fields.push('line_account_id = ?'); values.push(input.lineAccountId ?? null); }

  values.push(id);

  await db
    .prepare(`UPDATE tracked_links SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  return getTrackedLinkById(db, id);
}

// ── Click Recording ───────────────────────────────────────────────────────────

/**
 * リンククリックを記録する。
 * 同じ友達が同じリンクを2回目以降クリックした場合は、新規記録もカウント増加もしない（重複として無視）。
 * 友達IDが特定できないクリックは毎回記録する。
 * 戻り値: 新規にクリックを記録した場合は LinkClick、重複の場合は null
 */
export async function recordLinkClick(
  db: D1Database,
  trackedLinkId: string,
  friendId?: string | null,
): Promise<LinkClick | null> {
  const now = jstNow();

  // 同じ友達が同じリンクを既にクリックしているかチェック
  if (friendId) {
    const existing = await db
      .prepare(`SELECT id FROM link_clicks WHERE tracked_link_id = ? AND friend_id = ? LIMIT 1`)
      .bind(trackedLinkId, friendId)
      .first<{ id: string }>();
    if (existing) {
      // 重複クリックなので何もせず終了
      return null;
    }
  }

  const id = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO link_clicks (id, tracked_link_id, friend_id, clicked_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(id, trackedLinkId, friendId ?? null, now)
    .run();

  await db
    .prepare(
      `UPDATE tracked_links SET click_count = click_count + 1, updated_at = ? WHERE id = ?`,
    )
    .bind(now, trackedLinkId)
    .run();

  return (await db
    .prepare(`SELECT * FROM link_clicks WHERE id = ?`)
    .bind(id)
    .first<LinkClick>())!;
}

export interface LinkClickWithFriend extends LinkClick {
  friend_display_name: string | null;
}

export async function getLinkClicks(
  db: D1Database,
  trackedLinkId: string,
): Promise<LinkClickWithFriend[]> {
  const result = await db
    .prepare(
      `SELECT lc.*, f.display_name as friend_display_name
       FROM link_clicks lc
       LEFT JOIN friends f ON f.id = lc.friend_id
       WHERE lc.tracked_link_id = ?
       ORDER BY lc.clicked_at DESC`,
    )
    .bind(trackedLinkId)
    .all<LinkClickWithFriend>();
  return result.results;
}
