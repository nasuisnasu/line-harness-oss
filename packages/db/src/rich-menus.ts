import { jstNow } from './utils.js';

export type RichMenuSizeType = 'full' | 'compact';

export interface RichMenuArea {
  bounds: { x: number; y: number; width: number; height: number };
  action: {
    type: 'uri' | 'message' | 'postback' | 'richmenuswitch';
    label?: string;
    uri?: string;
    text?: string;
    data?: string;
    richMenuAliasId?: string;
  };
}

export interface RichMenu {
  id: string;
  line_account_id: string;
  name: string;
  line_richmenu_id: string | null;
  size_type: RichMenuSizeType;
  chat_bar_text: string;
  selected: number;
  areas_json: string;
  is_default: number;
  show_on_friend_add: number;
  created_at: string;
  updated_at: string;
}

export interface CreateRichMenuInput {
  lineAccountId: string;
  name: string;
  sizeType: RichMenuSizeType;
  chatBarText: string;
  selected?: boolean;
  areas: RichMenuArea[];
  isDefault?: boolean;
  showOnFriendAdd?: boolean;
}

export async function createRichMenuRecord(
  db: D1Database,
  input: CreateRichMenuInput,
): Promise<RichMenu> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO rich_menus (id, line_account_id, name, size_type, chat_bar_text, selected, areas_json, is_default, show_on_friend_add, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.lineAccountId,
      input.name,
      input.sizeType,
      input.chatBarText,
      input.selected !== false ? 1 : 0,
      JSON.stringify(input.areas),
      input.isDefault ? 1 : 0,
      input.showOnFriendAdd ? 1 : 0,
      now,
      now,
    )
    .run();

  return (await getRichMenuById(db, id))!;
}

export async function getRichMenuById(
  db: D1Database,
  id: string,
): Promise<RichMenu | null> {
  return db.prepare(`SELECT * FROM rich_menus WHERE id = ?`).bind(id).first<RichMenu>();
}

export async function getRichMenus(
  db: D1Database,
  lineAccountId?: string,
): Promise<RichMenu[]> {
  if (lineAccountId) {
    const result = await db
      .prepare(`SELECT * FROM rich_menus WHERE line_account_id = ? ORDER BY created_at DESC`)
      .bind(lineAccountId)
      .all<RichMenu>();
    return result.results;
  }
  const result = await db.prepare(`SELECT * FROM rich_menus ORDER BY created_at DESC`).all<RichMenu>();
  return result.results;
}

export async function getDefaultRichMenu(
  db: D1Database,
  lineAccountId: string,
): Promise<RichMenu | null> {
  return db
    .prepare(`SELECT * FROM rich_menus WHERE line_account_id = ? AND is_default = 1 LIMIT 1`)
    .bind(lineAccountId)
    .first<RichMenu>();
}

export async function getFriendAddRichMenu(
  db: D1Database,
  lineAccountId: string,
): Promise<RichMenu | null> {
  return db
    .prepare(`SELECT * FROM rich_menus WHERE line_account_id = ? AND show_on_friend_add = 1 LIMIT 1`)
    .bind(lineAccountId)
    .first<RichMenu>();
}

export interface UpdateRichMenuInput {
  name?: string;
  lineRichmenuId?: string | null;
  sizeType?: RichMenuSizeType;
  chatBarText?: string;
  selected?: boolean;
  areas?: RichMenuArea[];
  isDefault?: boolean;
  showOnFriendAdd?: boolean;
}

export async function updateRichMenuRecord(
  db: D1Database,
  id: string,
  input: UpdateRichMenuInput,
): Promise<RichMenu | null> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) { fields.push('name = ?'); values.push(input.name); }
  if (input.lineRichmenuId !== undefined) { fields.push('line_richmenu_id = ?'); values.push(input.lineRichmenuId); }
  if (input.sizeType !== undefined) { fields.push('size_type = ?'); values.push(input.sizeType); }
  if (input.chatBarText !== undefined) { fields.push('chat_bar_text = ?'); values.push(input.chatBarText); }
  if (input.selected !== undefined) { fields.push('selected = ?'); values.push(input.selected ? 1 : 0); }
  if (input.areas !== undefined) { fields.push('areas_json = ?'); values.push(JSON.stringify(input.areas)); }
  if (input.isDefault !== undefined) { fields.push('is_default = ?'); values.push(input.isDefault ? 1 : 0); }
  if (input.showOnFriendAdd !== undefined) { fields.push('show_on_friend_add = ?'); values.push(input.showOnFriendAdd ? 1 : 0); }

  if (fields.length === 0) return getRichMenuById(db, id);

  fields.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);

  await db.prepare(`UPDATE rich_menus SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();

  return getRichMenuById(db, id);
}

export async function deleteRichMenuRecord(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM rich_menus WHERE id = ?`).bind(id).run();
}

/** 同一アカウント内で他のメニューのis_defaultを0にする（1つだけがデフォルト） */
export async function clearOtherDefaults(
  db: D1Database,
  lineAccountId: string,
  exceptId: string,
): Promise<void> {
  await db
    .prepare(`UPDATE rich_menus SET is_default = 0 WHERE line_account_id = ? AND id != ?`)
    .bind(lineAccountId, exceptId)
    .run();
}

/** 同一アカウント内で他のメニューのshow_on_friend_addを0にする（1つだけ） */
export async function clearOtherFriendAddMenus(
  db: D1Database,
  lineAccountId: string,
  exceptId: string,
): Promise<void> {
  await db
    .prepare(`UPDATE rich_menus SET show_on_friend_add = 0 WHERE line_account_id = ? AND id != ?`)
    .bind(lineAccountId, exceptId)
    .run();
}

/** areas_jsonをパース */
export function parseRichMenuAreas(menu: RichMenu): RichMenuArea[] {
  try {
    return JSON.parse(menu.areas_json) as RichMenuArea[];
  } catch {
    return [];
  }
}
