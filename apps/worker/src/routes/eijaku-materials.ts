/**
 * 授業教材の受け取り（受講生専用）
 *
 * 授業のあとに講師が「生徒に公開」を押した教材を、生徒がリッチメニューから見るための経路。
 * 教材そのもの（PDF）は eijakuniki.com 側（ワーカー eijaku-ai）の R2 にあり、
 * ここは**誰の教材かを決めるだけ**で、ファイルは持たない。
 *
 *   生徒 ──(idToken)──▶ /api/eijaku/materials ──(共有鍵)──▶ eijaku-ai /shelf/for-line/:userId
 *
 * 生徒用は LIFF の idToken、棚からの呼び出しは共有鍵。認証経路を混ぜないこと。
 * 生徒用は authMiddleware をスキップさせているので、**このファイルのゲートが唯一の壁**。
 * 単語テストと同じ3段（routes/vocab.ts の requireStudent と同じ考え方）を通す。
 */

import { Hono } from 'hono';
import { getFriendByLineUserId } from '@line-crm/db';
import type { Friend } from '@line-crm/db';
import type { Env } from '../index.js';

export const eijakuMaterials = new Hono<Env>();

type Gate = { ok: true; friend: Friend } | { ok: false; status: 401 | 403 | 503 };

/**
 * 3段のゲート。1つでも欠けたら通さない。
 *
 *   1. idToken が LINE の検証エンドポイントで有効（client_id はサーバー側の env）
 *   2. 受講生専用OAの friends に存在する
 *   3. 受講生タグを持っている
 *
 * env が未設定のときは**通さない**（fail closed）。設定漏れのまま deploy して
 * 全員に開いてしまうほうが、初回に 503 で気づくよりずっと悪い。
 */
async function requireStudent(c: {
  req: { header(name: string): string | undefined };
  env: Env['Bindings'];
}): Promise<Gate> {
  const loginChannelId = c.env.VOCAB_LOGIN_CHANNEL_ID;
  const lineAccountId = c.env.VOCAB_LINE_ACCOUNT_ID;
  const allowTagId = c.env.VOCAB_ALLOW_TAG_ID;

  if (!loginChannelId || !lineAccountId || !allowTagId) {
    console.error(
      '[eijaku-materials] 設定が足りていません。VOCAB_LOGIN_CHANNEL_ID / VOCAB_LINE_ACCOUNT_ID / VOCAB_ALLOW_TAG_ID を設定してください',
    );
    return { ok: false, status: 503 };
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return { ok: false, status: 401 };
  const idToken = authHeader.slice('Bearer '.length);

  // ── 1段目：LINE に検証させる ──
  // 自前で JWT をデコードして sub を読むだけにしないこと。署名を見ていないので誰でも作れる。
  const verifyRes = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: loginChannelId }),
  });
  if (!verifyRes.ok) return { ok: false, status: 401 };
  const verified = await verifyRes.json<{ sub: string }>();

  // ── 2段目：受講生専用OAの友だちか ──
  const friend = await getFriendByLineUserId(c.env.DB, verified.sub, lineAccountId);
  if (!friend) return { ok: false, status: 403 };

  // ── 3段目：受講生タグを持っているか ──
  // 公式アカウントは ID を知られれば誰でも友だち追加できる。友だちであることだけでは絞れない。
  const tagged = await c.env.DB.prepare(
    `SELECT 1 FROM friend_tags WHERE friend_id = ? AND tag_id = ? LIMIT 1`,
  )
    .bind(friend.id, allowTagId)
    .first();
  if (!tagged) return { ok: false, status: 403 };

  return { ok: true, friend };
}

/** 403 のレスポンスに内部事情を書かない（生徒の有無や教材の中身を漏らさない）。 */
function denied(status: 401 | 403 | 503) {
  return status === 503
    ? ({ body: { success: false, error: 'サーバーの設定が完了していません' }, status } as const)
    : ({ body: { success: false, error: '受講生の方のみご利用いただけます' }, status } as const);
}

/**
 * 生徒用。自分に公開された教材だけを返す。
 * どの生徒の分を返すかは**サーバーが検証した sub から決める**。
 * クエリで生徒を指定させると、他人の教材が取れてしまう。
 */
eijakuMaterials.get('/api/eijaku/materials', async (c) => {
  const gate = await requireStudent(c);
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }

  const base = c.env.SHELF_API_URL;
  const key = c.env.SHELF_API_KEY;
  if (!base || !key) {
    console.error('[eijaku-materials] SHELF_API_URL / SHELF_API_KEY が未設定です');
    return c.json({ success: false, error: 'サーバーの設定が完了していません' }, 503);
  }

  const url =
    `${base}/shelf/for-line/${encodeURIComponent(gate.friend.line_user_id)}` +
    `?name=${encodeURIComponent(gate.friend.display_name || '')}`;
  const r = await fetch(url, { headers: { 'X-Shelf-Key': key } });
  if (!r.ok) {
    console.error(`[eijaku-materials] 棚から取得できませんでした: ${r.status}`);
    return c.json({ success: false, error: '教材を取得できませんでした' }, 502);
  }
  const data = await r.json<{ linked: boolean; name?: string; sets: unknown[] }>();

  // ファイルは棚のワーカーが配信する。URL をこちらで絶対パスに直しておく
  const sets = (data.sets as any[]).map((s) => ({
    ...s,
    files: (s.files as any[]).map((f) => ({ ...f, url: `${base}${f.url}` })),
  }));
  return c.json({ success: true, linked: data.linked, sets });
});

/**
 * 棚の管理画面で「生徒を追加」するときの選択肢。受講生タグの付いた友だちだけを返す。
 *
 * 呼ぶのは棚のワーカーだけ。ブラウザからは叩かせない。
 * 認証は**教材一覧と同じ共有鍵**（X-Shelf-Key）。管理用の API_KEY は使わない
 * ── 鍵を1本に絞ったほうが、行き違いで片方だけ古くなる事故が起きない。
 */
eijakuMaterials.get('/api/eijaku/students', async (c) => {
  const shared = c.env.SHELF_API_KEY;
  if (!shared) return c.json({ success: false, error: 'サーバーの設定が完了していません' }, 503);
  if (c.req.header('X-Shelf-Key') !== shared) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const lineAccountId = c.env.VOCAB_LINE_ACCOUNT_ID;
  const allowTagId = c.env.VOCAB_ALLOW_TAG_ID;
  if (!lineAccountId || !allowTagId) {
    return c.json({ success: false, error: 'サーバーの設定が完了していません' }, 503);
  }
  const rows = await c.env.DB.prepare(
    `SELECT f.line_user_id, f.display_name, f.picture_url
       FROM friends f
       JOIN friend_tags ft ON ft.friend_id = f.id
      WHERE f.line_account_id = ? AND ft.tag_id = ? AND f.is_following = 1
      ORDER BY f.display_name`,
  )
    .bind(lineAccountId, allowTagId)
    .all<{ line_user_id: string; display_name: string | null; picture_url: string | null }>();

  return c.json({
    success: true,
    friends: (rows.results || []).map((r) => ({
      lineUserId: r.line_user_id,
      displayName: r.display_name,
      pictureUrl: r.picture_url,
    })),
  });
});
