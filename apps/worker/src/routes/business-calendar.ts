// 営業カレンダー（休業日）API。
// - 管理画面: GET/PUT /api/business-calendar?lineAccountId=...（要認証）
// - 公開(LIFF): GET /api/public/accounts/:lineAccountId/business-calendar
import { Hono } from 'hono';
import { getBusinessCalendar, upsertBusinessCalendar } from '@line-crm/db';
import type { Env } from '../index.js';

const businessCalendar = new Hono<Env>();

// 管理画面: 取得
businessCalendar.get('/api/business-calendar', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    if (!lineAccountId) {
      return c.json({ success: false, error: 'lineAccountId is required' }, 400);
    }
    const data = await getBusinessCalendar(c.env.DB, lineAccountId);
    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/business-calendar error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// 管理画面: 更新
businessCalendar.put('/api/business-calendar', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    if (!lineAccountId) {
      return c.json({ success: false, error: 'lineAccountId is required' }, 400);
    }
    const body = await c.req.json<{ closedWeekdays?: number[]; closedDates?: string[]; notice?: string | null }>();
    const data = await upsertBusinessCalendar(c.env.DB, lineAccountId, {
      closedWeekdays: Array.isArray(body.closedWeekdays) ? body.closedWeekdays : undefined,
      closedDates: Array.isArray(body.closedDates) ? body.closedDates : undefined,
      ...('notice' in body ? { notice: body.notice ?? null } : {}),
    });
    return c.json({ success: true, data });
  } catch (err) {
    console.error('PUT /api/business-calendar error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// 公開(LIFF): 学生が見る休業日カレンダー
businessCalendar.get('/api/public/accounts/:lineAccountId/business-calendar', async (c) => {
  try {
    const lineAccountId = c.req.param('lineAccountId');
    const cal = await getBusinessCalendar(c.env.DB, lineAccountId);
    return c.json({
      success: true,
      data: {
        closedWeekdays: cal.closedWeekdays,
        closedDates: cal.closedDates,
        notice: cal.notice,
      },
    });
  } catch (err) {
    console.error('GET public business-calendar error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { businessCalendar };
