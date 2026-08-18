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
import { resolveCalendarAccessToken } from './events.js';
import { freeBusyCalendarIdsOf } from '@line-crm/db';

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
export async function requireStudent(c: {
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
export function denied(status: 401 | 403 | 503) {
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

  const key = c.env.SHELF_API_KEY;
  // ファイルを開くURLは生徒のブラウザが直接叩くので、公開URLが要る
  const base = c.env.SHELF_PUBLIC_URL;
  if (!c.env.SHELF || !key || !base) {
    console.error('[eijaku-materials] SHELF / SHELF_API_KEY / SHELF_PUBLIC_URL が未設定です');
    return c.json({ success: false, error: 'サーバーの設定が完了していません' }, 503);
  }

  // 呼び出しはサービスバインディング経由（同ゾーンのWorkerをURLで呼ぶと 1042 になる）
  const path =
    `/shelf/for-line/${encodeURIComponent(gate.friend.line_user_id)}` +
    `?name=${encodeURIComponent(gate.friend.display_name || '')}`;
  const r = await c.env.SHELF.fetch(`https://shelf${path}`, { headers: { 'X-Shelf-Key': key } });
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

/**
 * 管理ダッシュボード用。Googleカレンダーの直近の予定を返す。
 *
 * 呼ぶのは棚のワーカー（eijaku-ai）だけ。認証は /api/eijaku/students と同じ共有鍵。
 * カレンダーの認証情報（サービスアカウント）はこちら側にしか無いので、ここで取りに行く。
 */
eijakuMaterials.get('/api/eijaku/calendar', async (c) => {
  const shared = c.env.SHELF_API_KEY;
  if (!shared) return c.json({ success: false, error: 'サーバーの設定が完了していません' }, 503);
  if (c.req.header('X-Shelf-Key') !== shared) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const days = Math.min(Math.max(parseInt(c.req.query('days') || '14', 10) || 14, 1), 60);
  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + days * 86400000).toISOString();

  const conns = await c.env.DB.prepare(
    `SELECT calendar_id, freebusy_calendar_ids, auth_type, access_token
       FROM google_calendar_connections WHERE is_active = 1`,
  ).all<{
    calendar_id: string;
    freebusy_calendar_ids: string | null;
    auth_type: string;
    access_token: string | null;
  }>();

  const events: any[] = [];
  const calendars: { id: string; name: string }[] = [];
  const seen = new Set<string>();

  /** 1つのカレンダーから、期間内の予定を読む。落ちても他は続ける。 */
  const pull = async (id: string, name: string, token: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const url =
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events` +
      `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
      `&singleEvents=true&orderBy=startTime&maxResults=100`;
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return;
      const data = (await r.json()) as any;
      calendars.push({ id, name });
      for (const it of data.items || []) {
        events.push({
          title: it.summary || '(件名なし)',
          start: it.start?.dateTime || it.start?.date || '',
          end: it.end?.dateTime || it.end?.date || '',
          allDay: !it.start?.dateTime,
          location: it.location || '',
          calendar: id,
          calendarName: name,
        });
      }
    } catch {
      // 1つ落ちても、残りは返す
    }
  };

  // サービスアカウントに共有されているカレンダーを、まとめて拾います。
  // 接続テーブルに登録しなくても、共有した時点でここに出てきます
  // ── 「プライベート・授業・無料相談」のように増えていくものを、毎回登録させないためです。
  // 祝日カレンダーと、予定の中身を読めない権限（freeBusyReader）は除きます。
  let saEmail = '';
  try {
    saEmail = String(JSON.parse(c.env.GOOGLE_SA_JSON || '{}').client_email || '');
  } catch {
    // 読めなくても本体は動く
  }
  const saToken = await resolveCalendarAccessToken(
    { auth_type: 'service_account', access_token: null },
    c.env.GOOGLE_SA_JSON,
  );
  if (saToken) {
    try {
      const rl = await fetch(
        'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=100&showHidden=true',
        { headers: { Authorization: `Bearer ${saToken}` } },
      );
      if (!rl.ok) console.log('[calendar] calendarList NG: HTTP ' + rl.status);
      if (rl.ok) {
        const ld = (await rl.json()) as any;
        console.log(
          '[calendar] SA=' + saEmail + ' 見えているカレンダー: ' +
            (ld.items || []).map((x: any) => `${x.summary}(${x.accessRole})`).join(' / '),
        );
        for (const it of ld.items || []) {
          const id = String(it.id || '');
          if (!id || /holiday@group\.v\.calendar\.google\.com$/.test(id)) continue;
          if (it.accessRole === 'freeBusyReader') continue;
          await pull(id, String(it.summaryOverride || it.summary || id), saToken);
        }
      }
    } catch {
      // 一覧が取れなくても、下の接続テーブルぶんは読む
    }
  }

  // 空き判定で参照しているカレンダーを、そのまま表示にも使う。
  // サービスアカウントに共有しただけでは calendarList に載らない（共有＝ACLが付くだけで、
  // 一覧への追加は calendarList.insert という別操作）ので、上の自動発見は空振りします。
  // freebusy_calendar_ids には「プライベート・授業・無料相談」が既に入っているため、
  // ここを正としたほうが、設定が1か所で済み、空き判定と表示がずれません。
  if (saToken) {
    for (const conn of conns.results || []) {
      for (const id of freeBusyCalendarIdsOf(conn)) {
        if (seen.has(id)) continue;
        // 表示名はカレンダー本体から引く。取れなければIDのまま出す
        let name = id;
        try {
          const rc = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}`,
            { headers: { Authorization: `Bearer ${saToken}` } },
          );
          if (rc.ok) {
            const cd = (await rc.json()) as any;
            if (cd?.summary) name = String(cd.summary);
          }
        } catch {
          // 名前が引けなくても予定は出す
        }
        await pull(id, name, saToken);
      }
    }
  }

  // 接続テーブルにあって、上で拾えなかったもの（個別トークンのものなど）
  for (const conn of conns.results || []) {
    if (seen.has(conn.calendar_id)) continue;
    const token = await resolveCalendarAccessToken(
      { auth_type: conn.auth_type, access_token: conn.access_token },
      c.env.GOOGLE_SA_JSON,
    );
    if (!token) continue;
    let name = conn.calendar_id;
    try {
      const rc = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(conn.calendar_id)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (rc.ok) {
        const cd = (await rc.json()) as any;
        if (cd?.summary) name = String(cd.summary);
      }
    } catch {
      // 名前が取れなくても続ける
    }
    await pull(conn.calendar_id, name, token);
  }

  calendars.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return c.json({ success: true, events, calendars, serviceAccount: saEmail });
});


/**
 * 管理ダッシュボード用。LINE側のKPIを返す。
 *
 * 呼ぶのは棚のワーカー（eijaku-ai）だけ。認証は /api/eijaku/students と同じ共有鍵。
 * YouTube の再生数はこちらでは持っていない（キーは eijaku-ai 側）ので、
 * ここが返すのは **D1 から数えられるものだけ** です。
 *
 * 期間は「直近30日」と「累計」の2本立て。
 * 直近だけだと立ち上がりの母数が見えず、累計だけだと今月動いたかが見えないためです。
 */
eijakuMaterials.get('/api/eijaku/kpi', async (c) => {
  const shared = c.env.SHELF_API_KEY;
  if (!shared) return c.json({ success: false, error: 'サーバーの設定が完了していません' }, 503);
  if (c.req.header('X-Shelf-Key') !== shared) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  // 集客用のOA（受講生専用ではないほう）。ここを取り違えると母数が8人になります。
  const OA = '40adcb23-277b-4d9d-b6e2-92fde47d31fb';
  const TAG_CONSULT = '28f067b2-ba9f-4e85-b0c9-f4d5ed34a054'; // 無料相談 申込済み
  const TAG_YOUTUBE = 'a600648d-2088-495d-b65f-3775243cc780'; // Youtubeから流入
  const TAG_STRATEGY = '7f62de57-8204-4ff9-81ae-e2a7f92dbc5b'; // 戦略会議 申込済み

  const days = Math.min(Math.max(parseInt(c.req.query('days') || '30', 10) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const sinceDate = since.slice(0, 10); // paid_at は YYYY-MM-DD

  const one = async <T>(sql: string, ...binds: unknown[]) =>
    (await c.env.DB.prepare(sql)
      .bind(...binds)
      .first<T>()) as T;

  const [friends, adds, yt, consult, strategy, revenue] = await Promise.all([
    one<{ n: number; total: number }>(
      // ここは COUNT(*) all と書くと落ちます。all はSQLの予約語です。
      `SELECT SUM(CASE WHEN is_following = 1 THEN 1 ELSE 0 END) n, COUNT(*) total
         FROM friends WHERE line_account_id = ?`,
      OA,
    ),
    one<{ n: number }>(
      `SELECT COUNT(*) n FROM friends WHERE line_account_id = ? AND created_at >= ?`,
      OA,
      since,
    ),
    one<{ n: number; total: number }>(
      `SELECT SUM(CASE WHEN ft.assigned_at >= ? THEN 1 ELSE 0 END) n, COUNT(*) total
         FROM friend_tags ft WHERE ft.tag_id = ?`,
      since,
      TAG_YOUTUBE,
    ),
    one<{ n: number; total: number }>(
      `SELECT SUM(CASE WHEN ft.assigned_at >= ? THEN 1 ELSE 0 END) n, COUNT(*) total
         FROM friend_tags ft WHERE ft.tag_id = ?`,
      since,
      TAG_CONSULT,
    ),
    one<{ n: number; total: number }>(
      `SELECT SUM(CASE WHEN ft.assigned_at >= ? THEN 1 ELSE 0 END) n, COUNT(*) total
         FROM friend_tags ft WHERE ft.tag_id = ?`,
      since,
      TAG_STRATEGY,
    ),
    one<{ n: number; total: number; deals: number; dealsTotal: number }>(
      `SELECT COALESCE(SUM(CASE WHEN paid_at >= ? THEN amount ELSE 0 END), 0) n,
              COALESCE(SUM(amount), 0) total,
              SUM(CASE WHEN paid_at >= ? THEN 1 ELSE 0 END) deals,
              COUNT(*) dealsTotal
         FROM friend_payments`,
      sinceDate,
      sinceDate,
    ),
  ]);

  const friendsTotal = friends?.n || 0;
  const revenueTotal = revenue?.total || 0;

  return c.json({
    success: true,
    days,
    friendsTotal,
    // 累計の追加数。ブロックした人も「一度は入口を通った人」なので、ファネルではこちらを使います。
    friendsAll: friends?.total || 0,
    friendsNew: adds?.n || 0,
    youtubeInflow: yt?.n || 0,
    youtubeInflowTotal: yt?.total || 0,
    consult: consult?.n || 0,
    consultTotal: consult?.total || 0,
    strategy: strategy?.n || 0,
    strategyTotal: strategy?.total || 0,
    revenue: revenue?.n || 0,
    revenueTotal,
    deals: revenue?.deals || 0,
    dealsTotal: revenue?.dealsTotal || 0,
    // リスト単価＝これまでの売上 ÷ いまの友だち数。母数が動くので厳密な単価ではなく、目安です。
    listValue: friendsTotal ? Math.round(revenueTotal / friendsTotal) : 0,
  });
});
