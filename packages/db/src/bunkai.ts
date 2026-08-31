/**
 * 古文の品詞分解チェッカー — D1 の出し入れ
 *
 * スキーマは `packages/db/migrations/070_bunkai.sql`。
 * 分解そのものを作るのは `apps/worker/src/lib/kobun-parser.ts`。ここは保存と取り出しだけ。
 */

import { jstNow } from './utils';

/** 分解1件（キャッシュの行）。`result` は JSON 文字列のまま持ち回る。 */
export interface BunkaiParse {
  id: number;
  text_hash: string;
  text: string;
  result: string;
  model: string;
  created_at: string;
}

/** 生徒の履歴1件。画面には本文と日付しか出さない。 */
export interface BunkaiHistoryItem {
  parse_id: number;
  text: string;
  created_at: string;
}

/**
 * 本文の正規化。**キャッシュのキーはこれを通した文字列から作る。**
 *
 * 揺れを吸収しないと、同じ文なのに全角スペース1個の違いで買い直しになる。
 * ただし**歴史的仮名遣いには一切触らない**。「けふ」を「きょう」に直すような
 * 正規化を入れると、分解する対象そのものが変わってしまう。
 */
export function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[　\t]/g, ' ') // 全角スペースとタブは半角スペースに寄せる
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/** 正規化済みの本文から SHA-256（hex）を作る。Workers の crypto.subtle を使う。 */
export async function hashText(normalized: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** キャッシュを引く。無ければ null。 */
export async function getBunkaiParseByHash(
  db: D1Database,
  textHash: string,
): Promise<BunkaiParse | null> {
  return await db
    .prepare(`SELECT * FROM bunkai_parses WHERE text_hash = ? LIMIT 1`)
    .bind(textHash)
    .first<BunkaiParse>();
}

/** id で引く（履歴からもう一度開くとき）。 */
export async function getBunkaiParseById(
  db: D1Database,
  id: number,
): Promise<BunkaiParse | null> {
  return await db.prepare(`SELECT * FROM bunkai_parses WHERE id = ? LIMIT 1`).bind(id).first<BunkaiParse>();
}

/**
 * 分解を保存して行を返す。
 *
 * 同じ hash が同時に2回来ることがある（2人が同じ文を同じ瞬間に投げる）。
 * UNIQUE 制約で落ちるので `ON CONFLICT DO NOTHING` で受け流し、必ず読み直して返す。
 * 「後から来たほうが失敗する」ようにはしない。**どちらの生徒にも同じ答えが出るべき**なので。
 */
export async function saveBunkaiParse(
  db: D1Database,
  input: { textHash: string; text: string; result: string; model: string },
): Promise<BunkaiParse> {
  await db
    .prepare(
      `INSERT INTO bunkai_parses (text_hash, text, result, model, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (text_hash) DO NOTHING`,
    )
    .bind(input.textHash, input.text, input.result, input.model, jstNow())
    .run();

  const row = await getBunkaiParseByHash(db, input.textHash);
  if (!row) throw new Error('分解の保存に失敗しました');
  return row;
}

/**
 * 誰が何を引いたかを1行残す。`cached` が 0 の分だけが1日の上限に効く。
 *
 * `parseId` が null なのは「叩いたが保存する分解が無かった」とき（＝古文でなかった）。
 * 結果を残さなくても**上限には数える**。数えないと、古文でない文字列を投げるだけで
 * 無料でAPIを回せてしまう。
 */
export async function logBunkaiRequest(
  db: D1Database,
  input: { friendId: string; parseId: number | null; cached: boolean },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bunkai_requests (friend_id, parse_id, cached, created_at) VALUES (?, ?, ?, ?)`,
    )
    .bind(input.friendId, input.parseId, input.cached ? 1 : 0, jstNow())
    .run();
}

/**
 * その生徒が今日 API を叩いた回数。**キャッシュから返した分は数えない。**
 *
 * created_at は JST の ISO 文字列なので、先頭10文字がそのまま JST の日付になる。
 * ここで UTC の日付と比べると、日本の朝9時までが前日に数えられてしまう。
 */
export async function countBunkaiCallsToday(db: D1Database, friendId: string): Promise<number> {
  const today = jstNow().slice(0, 10);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM bunkai_requests
       WHERE friend_id = ? AND cached = 0 AND substr(created_at, 1, 10) = ?`,
    )
    .bind(friendId, today)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * その生徒の履歴。同じ文を何度も引いていても1行にまとめる（最後に引いた日時で並べる）。
 * 「昨日と同じ文をまた引いた」ことは指導では意味があるが、一覧が同じ行で埋まるほうが困る。
 */
export async function listBunkaiHistory(
  db: D1Database,
  friendId: string,
  limit = 30,
): Promise<BunkaiHistoryItem[]> {
  const res = await db
    .prepare(
      `SELECT p.id AS parse_id, p.text AS text, MAX(r.created_at) AS created_at
         FROM bunkai_requests r
         JOIN bunkai_parses p ON p.id = r.parse_id
        WHERE r.friend_id = ?
        GROUP BY p.id
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(friendId, limit)
    .all<BunkaiHistoryItem>();
  return res.results ?? [];
}

/** 管理画面用：直近みんなが何を投げたか。生徒がどこで詰まっているかの一次情報。 */
export async function listBunkaiRecent(
  db: D1Database,
  limit = 100,
): Promise<Array<{ friend_id: string; display_name: string | null; text: string; cached: number; created_at: string }>> {
  const res = await db
    .prepare(
      `SELECT r.friend_id, f.display_name, p.text, r.cached, r.created_at
         FROM bunkai_requests r
         JOIN bunkai_parses p ON p.id = r.parse_id
         LEFT JOIN friends f ON f.id = r.friend_id
        ORDER BY r.created_at DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<{ friend_id: string; display_name: string | null; text: string; cached: number; created_at: string }>();
  return res.results ?? [];
}
