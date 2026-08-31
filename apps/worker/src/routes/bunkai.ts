/**
 * 古文の品詞分解チェッカー（受講生専用）
 *
 * 生徒が古文を入れると、品詞分解・文法事項・判断の根拠・訳のニュアンスを返す。
 * 自分で分解したものと突き合わせて、合っているかを確かめるための道具。
 *
 * ゲートは単語・文法テストと同じ `requireStudent`（3段）。env も VOCAB_* を共用する。
 *
 * ★ 他の生徒用APIと決定的に違う点：**叩くたびにお金がかかる。**
 *   だから壁が3枚ある。
 *     1. 受講生ゲート（他と同じ）
 *     2. 字数の上限 …… 1回あたりの単価を抑える
 *     3. 1日の回数の上限 …… 1人あたりの1日の額を抑える
 *   さらにキャッシュで、同じ文は2回買わない。
 */
import { Hono } from 'hono';
import {
  normalizeText,
  hashText,
  getBunkaiParseByHash,
  getBunkaiParseById,
  saveBunkaiParse,
  logBunkaiRequest,
  countBunkaiCallsToday,
  listBunkaiHistory,
  listBunkaiRecent,
} from '@line-crm/db';
import { requireStudent, denied } from '../lib/student-gate.js';
import { parseKobun, ParserError, DEFAULT_MODEL } from '../lib/kobun-parser.js';
import type { Env } from '../index.js';

export const bunkai = new Hono<Env>();

/**
 * 1回に投げられる字数。
 *
 * 品詞分解は1文〜数文でやるもの。長文をまるごと投げる道具ではないし、
 * 長いほど分解の質も落ちる（どこの話かが薄まる）。
 * 費用の上限としても効く。
 */
const MAX_CHARS = 300;

/** 1日に API を叩ける回数（1人あたり）。キャッシュに当たった分は数えない。 */
const DEFAULT_DAILY_LIMIT = 20;

function dailyLimit(env: Env['Bindings']): number {
  const n = Number(env.BUNKAI_DAILY_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT;
}

/**
 * 分解する。
 *
 * 手順：正規化 → hash → キャッシュを引く → 無ければ上限を見て API を叩く。
 * **上限を見るのはキャッシュを引いたあと。** 先に見ると、タダで返せる文まで
 * 上限で弾いてしまう。
 */
bunkai.post('/api/bunkai/parse', async (c) => {
  const gate = await requireStudent(c, 'bunkai');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }

  const body = await c.req.json<{ text?: string }>().catch(() => ({}) as { text?: string });
  const text = normalizeText(body.text || '');
  if (!text) {
    return c.json({ success: false, error: '古文を入力してください' }, 400);
  }
  if (text.length > MAX_CHARS) {
    return c.json(
      {
        success: false,
        error: `${MAX_CHARS}文字までです（いまは${text.length}文字）。一文ずつ区切って調べてください`,
      },
      400,
    );
  }

  const textHash = await hashText(text);

  // ── キャッシュ ──
  // 同じ文は誰が引いても同じ答えなので、生徒をまたいで共有する。
  const cached = await getBunkaiParseByHash(c.env.DB, textHash);
  if (cached) {
    await logBunkaiRequest(c.env.DB, { friendId: gate.friend.id, parseId: cached.id, cached: true });
    return c.json({
      success: true,
      parse_id: cached.id,
      text: cached.text,
      result: JSON.parse(cached.result),
      cached: true,
    });
  }

  // ── ここから先はお金がかかる ──
  if (!c.env.ANTHROPIC_API_KEY) {
    console.error('[bunkai] ANTHROPIC_API_KEY が未設定');
    return c.json({ success: false, error: 'サーバーの設定が完了していません' }, 503);
  }

  const limit = dailyLimit(c.env);
  const used = await countBunkaiCallsToday(c.env.DB, gate.friend.id);
  if (used >= limit) {
    return c.json(
      {
        success: false,
        error: `今日の上限（${limit}回）に達しました。明日また使えます`,
        limit,
        used,
      },
      429,
    );
  }

  try {
    const { result, model } = await parseKobun(text, {
      apiKey: c.env.ANTHROPIC_API_KEY,
      model: c.env.BUNKAI_MODEL,
      effort: c.env.BUNKAI_EFFORT,
    });

    // 古文でなかったものはキャッシュしない。
    // 「英語を貼ってしまった」のような打ち間違いを永久に持ち続けても意味がない。
    // ただし parse_id を NULL にして**記録は残す**。API は実際に叩いているので、
    // ここを数えないと古文でない文字列を投げ続けるだけで上限をすり抜けられる。
    if (!result.is_kobun) {
      await logBunkaiRequest(c.env.DB, { friendId: gate.friend.id, parseId: null, cached: false });
      return c.json({
        success: true,
        parse_id: null,
        text,
        result,
        cached: false,
        remaining: Math.max(0, limit - used - 1),
      });
    }

    const saved = await saveBunkaiParse(c.env.DB, {
      textHash,
      text,
      result: JSON.stringify(result),
      model,
    });
    await logBunkaiRequest(c.env.DB, { friendId: gate.friend.id, parseId: saved.id, cached: false });

    return c.json({
      success: true,
      parse_id: saved.id,
      text,
      result,
      cached: false,
      remaining: Math.max(0, limit - used - 1),
    });
  } catch (err) {
    if (err instanceof ParserError) {
      return c.json({ success: false, error: err.message }, err.status);
    }
    console.error('[bunkai] 想定外のエラー', err);
    return c.json({ success: false, error: '分解に失敗しました。もう一度お試しください' }, 502);
  }
});

/** 今日あと何回使えるか。画面を開いたときに出す。 */
bunkai.get('/api/bunkai/quota', async (c) => {
  const gate = await requireStudent(c, 'bunkai');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const limit = dailyLimit(c.env);
  const used = await countBunkaiCallsToday(c.env.DB, gate.friend.id);
  return c.json({ success: true, limit, used, remaining: Math.max(0, limit - used), max_chars: MAX_CHARS });
});

/** 自分が今までに調べた文。もう一度開くのはキャッシュに当たるのでタダ。 */
bunkai.get('/api/bunkai/history', async (c) => {
  const gate = await requireStudent(c, 'bunkai');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const items = await listBunkaiHistory(c.env.DB, gate.friend.id, 30);
  return c.json({ success: true, items });
});

/** 履歴から1件開く。自分が引いたことのある文だけを開ける。 */
bunkai.get('/api/bunkai/parses/:id', async (c) => {
  const gate = await requireStudent(c, 'bunkai');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ success: false, error: 'not found' }, 404);
  }

  // 自分の履歴にあるかを確かめてから返す。
  // id は連番なので、確かめないと他人が引いた文を総なめできてしまう。
  const own = await c.env.DB.prepare(
    `SELECT 1 FROM bunkai_requests WHERE friend_id = ? AND parse_id = ? LIMIT 1`,
  )
    .bind(gate.friend.id, id)
    .first();
  if (!own) return c.json({ success: false, error: 'not found' }, 404);

  const row = await getBunkaiParseById(c.env.DB, id);
  if (!row) return c.json({ success: false, error: 'not found' }, 404);

  await logBunkaiRequest(c.env.DB, { friendId: gate.friend.id, parseId: row.id, cached: true });
  return c.json({
    success: true,
    parse_id: row.id,
    text: row.text,
    result: JSON.parse(row.result),
    cached: true,
  });
});

// ── 管理（API_KEY で守られる。authMiddleware を素通りしない） ──

/** 直近みんなが何を投げたか。どこで詰まっているかの一次情報になる。 */
bunkai.get('/api/bunkai/admin/recent', async (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 100, 500);
  const items = await listBunkaiRecent(c.env.DB, limit);
  return c.json({ success: true, items, model: c.env.BUNKAI_MODEL || DEFAULT_MODEL });
});
