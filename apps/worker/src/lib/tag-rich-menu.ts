/**
 * タグ連動リッチメニュー
 *
 * 「このタグが付いた人にはこのメニューを出す」を一箇所で実行する。
 * 最初の用途は受講登録フォーム（属性=生徒 → 生徒タグ → 受講生用メニュー）。
 *
 * タグを付ける経路はフォーム送信・管理画面の手動付与・postbackと複数ある。
 * リンク処理をそれぞれに書くと、経路を増やしたときにメニューだけ出ないという
 * 沈黙する差が生まれるので、必ずこの関数を呼ぶこと。
 *
 * 失敗しても呼び出し元は落とさない（メニューが出ないだけで、タグ付けや提出は成立する）。
 */

import { getRichMenusByAutoLinkTags, getLineAccountById } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';

/**
 * 付いたタグに応じてリッチメニューをリンクする。
 *
 * @param tagIds  今回付与したタグ（すでに持っていたタグを含めても害はない）
 * @param fallbackToken  友だちにOAが紐づいていないときのチャネルトークン
 */
export async function applyTagRichMenu(
  db: D1Database,
  friendId: string,
  tagIds: string[],
  fallbackToken: string,
): Promise<void> {
  try {
    const unique = [...new Set(tagIds.filter(Boolean))];
    if (unique.length === 0) return;

    const friend = await db
      .prepare(`SELECT line_user_id, line_account_id FROM friends WHERE id = ?`)
      .bind(friendId)
      .first<{ line_user_id: string; line_account_id: string | null }>();
    if (!friend?.line_user_id || !friend.line_account_id) return;

    const menus = await getRichMenusByAutoLinkTags(db, friend.line_account_id, unique);
    if (menus.length === 0) return;
    // 1タグ=1メニューの前提。複数当たったら新しいものを出しつつ、設定ミスとして残す。
    if (menus.length > 1) {
      console.warn(
        `[tag-rich-menu] friend=${friendId} に ${menus.length} 件のメニューが該当しました。` +
          `タグ連動は1タグ1メニューで設定してください: ${menus.map((m) => m.name).join(' / ')}`,
      );
    }
    const menu = menus[0];

    // トークンはそのOAのもの。共通トークンで別OAの利用者にリンクしても 400 になる。
    const account = await getLineAccountById(db, friend.line_account_id);
    const token = account?.channel_access_token ?? fallbackToken;
    if (!token) return;

    const client = new LineClient(token);
    await client.linkRichMenuToUser(friend.line_user_id, menu.line_richmenu_id!);
    console.log(`[tag-rich-menu] friend=${friendId} に「${menu.name}」をリンクしました`);
  } catch (err) {
    console.error('[tag-rich-menu] リンクに失敗しました:', err);
  }
}
