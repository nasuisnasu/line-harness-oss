/**
 * 受講生ゲート（LIFF の idToken で守る生徒用API 共通）
 *
 * 正本は `.company/英弱ニキ/lms/vocab/10-access-control.md`。
 *
 * 単語テストと文法テストが同じ壁を使う。**コピーを増やさないこと。**
 * ゲートの実装が分裂すると、片方だけ穴が開いても気づけない。
 *
 * この壁を通る生徒用エンドポイントは authMiddleware をスキップさせてある
 * （Authorization ヘッダを API_KEY ではなく idToken に使うため）。
 * したがってこの関数が唯一の壁で、各ハンドラの先頭で必ず通す。
 */

import { getFriendByLineUserId } from '@line-crm/db';
import type { Friend } from '@line-crm/db';
import type { Env } from '../index.js';

export type Gate =
  | { ok: true; friend: Friend }
  | { ok: false; status: 401 | 403 | 503; message: string };

/**
 * 3段のゲート。1つでも欠けたら通さない。
 *
 *   1. idToken が LINE の検証エンドポイントで有効（client_id はサーバー側の env）
 *   2. 受講生専用OAの friends に存在する
 *   3. 受講生タグを持っている
 *
 * env が未設定のときは**通さない**（fail closed）。設定漏れのまま deploy して
 * 全員に開いてしまうほうが、初回に 503 で気づくよりずっと悪い。
 *
 * env は単語テストのものを共用する（VOCAB_*）。受講生専用OAも受講生タグも
 * 同じものなので、機能ごとに別の env を持つと設定漏れの箇所が増えるだけ。
 */
export async function requireStudent(
  c: {
    req: { header(name: string): string | undefined };
    env: Env['Bindings'];
  },
  label = 'student-gate',
): Promise<Gate> {
  const loginChannelId = c.env.VOCAB_LOGIN_CHANNEL_ID;
  const lineAccountId = c.env.VOCAB_LINE_ACCOUNT_ID;
  const allowTagId = c.env.VOCAB_ALLOW_TAG_ID;

  if (!loginChannelId || !lineAccountId || !allowTagId) {
    console.error(
      `[${label}] 設定が足りていません。VOCAB_LOGIN_CHANNEL_ID / VOCAB_LINE_ACCOUNT_ID / VOCAB_ALLOW_TAG_ID を設定してください`,
    );
    return { ok: false, status: 503, message: 'not configured' };
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, status: 401, message: 'unauthorized' };
  }
  const idToken = authHeader.slice('Bearer '.length);

  // ── 1段目：LINE に検証させる ──
  // 自前で JWT をデコードして sub を読むだけにしないこと。署名を見ていないので誰でも作れる。
  // client_id を渡さないと、別チャネルで発行されたトークンが通ってしまう。
  const verifyRes = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: loginChannelId }),
  });
  if (!verifyRes.ok) {
    return { ok: false, status: 401, message: 'unauthorized' };
  }
  const verified = await verifyRes.json<{ sub: string }>();

  // ── 2段目：受講生専用OAの友だちか ──
  const friend = await getFriendByLineUserId(c.env.DB, verified.sub, lineAccountId);
  if (!friend) {
    return { ok: false, status: 403, message: 'forbidden' };
  }

  // ── 3段目：受講生タグを持っているか ──
  // LINE公式アカウントは ID を知られれば誰でも友だち追加できる。
  // 「友だちであること」だけでは受講生に絞れない。
  const tagged = await c.env.DB.prepare(
    `SELECT 1 FROM friend_tags WHERE friend_id = ? AND tag_id = ? LIMIT 1`,
  )
    .bind(friend.id, allowTagId)
    .first();
  if (!tagged) {
    return { ok: false, status: 403, message: 'forbidden' };
  }

  return { ok: true, friend };
}

/** 403 のレスポンスに内部事情を書かない（問題数・問題集名・生徒の有無を漏らさない）。 */
export function denied(status: 401 | 403 | 503) {
  const body =
    status === 503
      ? { success: false, error: 'サーバーの設定が完了していません' }
      : { success: false, error: '受講生の方のみご利用いただけます' };
  return { body, status } as const;
}
