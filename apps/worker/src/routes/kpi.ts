// KPI: funnel summary for the dashboard.
// 流入(友達追加) → top(戦略会議/勉強会等) → mid(個別説明会) → 成約(支払い)
// の各段階の件数とCVRを返す。top イベントごとの内訳も返すので
// 「どの企画がよくハネるか」を横並び比較できる。
import { Hono } from 'hono';
import type { Env } from '../index.js';

const kpi = new Hono<Env>();

interface DailyRow { day: string; count: number; amount?: number }

function todayJst(): string {
  const d = new Date(Date.now() + 9 * 60 * 60_000);
  return d.toISOString().slice(0, 10);
}

function jstDateNDaysAgo(days: number): string {
  const d = new Date(Date.now() + 9 * 60 * 60_000);
  d.setDate(d.getDate() - days + 1);
  return d.toISOString().slice(0, 10);
}

kpi.get('/api/kpi/funnel-summary', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId') ?? null;
    const days = Math.min(Math.max(Number(c.req.query('days') ?? '30'), 1), 365);
    const from = jstDateNDaysAgo(days);
    const to = todayJst();
    // 包含で集計: created_at LIKE 'YYYY-MM-DD%' なので、to は当日0時を含み、上限は to + 'T99' で済む
    const accountFilter = lineAccountId ? 'AND line_account_id = ?' : '';
    const accountBind = lineAccountId ? [lineAccountId] : [];

    // ── 1. 流入数（新規友達追加） ────────────────────────────
    const friendsAddedRow = await c.env.DB
      .prepare(
        `SELECT COUNT(*) as cnt FROM friends
         WHERE substr(created_at, 1, 10) BETWEEN ? AND ?
         ${accountFilter}`,
      )
      .bind(from, to, ...accountBind)
      .first<{ cnt: number }>();
    const friendsAdded = friendsAddedRow?.cnt ?? 0;

    // ── 2. top / mid イベント別の予約 ─────────────────────────
    // top: funnel_role='top'、mid: funnel_role='mid'
    const eventConditions: string[] = ['1=1'];
    const eventBind: unknown[] = [];
    if (lineAccountId) { eventConditions.push('line_account_id = ?'); eventBind.push(lineAccountId); }
    const eventRows = await c.env.DB
      .prepare(
        `SELECT id, name, funnel_role, event_format
         FROM events WHERE ${eventConditions.join(' AND ')}
           AND funnel_role IN ('top', 'mid')`,
      )
      .bind(...eventBind)
      .all<{ id: string; name: string; funnel_role: string; event_format: string | null }>();
    const events = eventRows.results ?? [];
    const topEventIds = events.filter((e) => e.funnel_role === 'top').map((e) => e.id);
    const midEventIds = events.filter((e) => e.funnel_role === 'mid').map((e) => e.id);

    async function distinctFriendsForEvents(eventIds: string[]): Promise<number> {
      if (eventIds.length === 0) return 0;
      const placeholders = eventIds.map(() => '?').join(',');
      const row = await c.env.DB
        .prepare(
          `SELECT COUNT(DISTINCT friend_id) as cnt
           FROM calendar_bookings
           WHERE app_event_id IN (${placeholders})
             AND status='confirmed'
             AND substr(created_at, 1, 10) BETWEEN ? AND ?`,
        )
        .bind(...eventIds, from, to)
        .first<{ cnt: number }>();
      return row?.cnt ?? 0;
    }

    const topUniqueFriends = await distinctFriendsForEvents(topEventIds);
    const midUniqueFriends = await distinctFriendsForEvents(midEventIds);

    // ── 3. 成約（payments） ──────────────────────────────────
    const paymentRow = await c.env.DB
      .prepare(
        `SELECT COUNT(DISTINCT fp.friend_id) as friends,
                COALESCE(SUM(fp.amount), 0) as revenue
         FROM friend_payments fp
         JOIN friends f ON f.id = fp.friend_id
         WHERE substr(fp.paid_at, 1, 10) BETWEEN ? AND ?
         ${lineAccountId ? 'AND f.line_account_id = ?' : ''}`,
      )
      .bind(from, to, ...(lineAccountId ? [lineAccountId] : []))
      .first<{ friends: number; revenue: number }>();
    const closedFriends = paymentRow?.friends ?? 0;
    const revenue = paymentRow?.revenue ?? 0;

    // ── 4. top イベント別の breakdown ─────────────────────────
    // 各 top イベントを 1 行にして、流入→top→mid→成約 のCVRを計算
    type TopBreakdown = {
      eventId: string;
      name: string;
      eventFormat: string | null;
      topUniqueFriends: number;       // この top に来た distinct friend 数
      midUniqueFriends: number;       // top → mid に進んだ distinct friend 数
      closedFriends: number;          // mid → 成約した distinct friend 数
      revenue: number;
    };
    const breakdown: TopBreakdown[] = [];
    for (const ev of events.filter((e) => e.funnel_role === 'top')) {
      // top の participants
      const topRow = await c.env.DB
        .prepare(
          `SELECT DISTINCT friend_id FROM calendar_bookings
           WHERE app_event_id = ?
             AND status='confirmed'
             AND substr(created_at, 1, 10) BETWEEN ? AND ?`,
        )
        .bind(ev.id, from, to)
        .all<{ friend_id: string }>();
      const topFriendIds = (topRow.results ?? []).map((r) => r.friend_id);
      const topCount = topFriendIds.length;

      // top friends のうち mid を予約した distinct 数
      let midCount = 0;
      let closedCount = 0;
      let topRevenue = 0;
      if (topCount > 0 && midEventIds.length > 0) {
        const fp = topFriendIds.map(() => '?').join(',');
        const mp = midEventIds.map(() => '?').join(',');
        const midR = await c.env.DB
          .prepare(
            `SELECT COUNT(DISTINCT friend_id) as cnt FROM calendar_bookings
             WHERE friend_id IN (${fp})
               AND app_event_id IN (${mp})
               AND status='confirmed'`,
          )
          .bind(...topFriendIds, ...midEventIds)
          .first<{ cnt: number }>();
        midCount = midR?.cnt ?? 0;
      }
      if (topCount > 0) {
        const fp = topFriendIds.map(() => '?').join(',');
        const cR = await c.env.DB
          .prepare(
            `SELECT COUNT(DISTINCT friend_id) as cnt, COALESCE(SUM(amount),0) as amt
             FROM friend_payments
             WHERE friend_id IN (${fp})`,
          )
          .bind(...topFriendIds)
          .first<{ cnt: number; amt: number }>();
        closedCount = cR?.cnt ?? 0;
        topRevenue = cR?.amt ?? 0;
      }

      breakdown.push({
        eventId: ev.id,
        name: ev.name,
        eventFormat: ev.event_format,
        topUniqueFriends: topCount,
        midUniqueFriends: midCount,
        closedFriends: closedCount,
        revenue: topRevenue,
      });
    }

    return c.json({
      success: true,
      data: {
        period: { from, to, days },
        overall: {
          friendsAdded,
          topUniqueFriends,
          midUniqueFriends,
          closedFriends,
          revenue,
        },
        topBreakdown: breakdown.sort((a, b) => b.topUniqueFriends - a.topUniqueFriends),
      },
    });
  } catch (err) {
    console.error('GET /api/kpi/funnel-summary error:', err);
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }
});

export { kpi };
