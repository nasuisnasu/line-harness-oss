/**
 * 受講生の目標日 — 単語テストと文法テストで共通のAPI
 *
 * どちらの画面にも上に出るカウントダウンの設定。**1つ設定すれば両方に効く。**
 * 機能ごとに分けない理由は `packages/db/migrations/064_lms_goals.sql`。
 *
 * ゲートは単語・文法と同じ `requireStudent`（3段）。env も `VOCAB_*` を共用する。
 */
import { Hono } from 'hono';
import { getLmsGoal, putLmsGoal, deleteLmsGoal } from '@line-crm/db';
import { requireStudent, denied } from '../lib/student-gate.js';
import type { Env } from '../index.js';

export const lms = new Hono<Env>();

/** 見出しの長さ。画面に収まる範囲で切る。 */
const MAX_LABEL = 20;
/** 何年先まで許すか。打ち間違いで「3000年」が入るのを防ぐだけ。 */
const MAX_YEARS_AHEAD = 10;

function validDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return false;
  const limit = new Date();
  limit.setFullYear(limit.getFullYear() + MAX_YEARS_AHEAD);
  return d <= limit;
}

lms.get('/api/lms/goal', async (c) => {
  const gate = await requireStudent(c, 'lms');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const goal = await getLmsGoal(c.env.DB, gate.friend.id);
  // 未設定は null を返す。**既定（共通テスト）は画面側で作る。**
  // サーバーが既定日を作ると、年が変わったときに両方直す必要が出る。
  return c.json({ success: true, goal });
});

lms.put('/api/lms/goal', async (c) => {
  const gate = await requireStudent(c, 'lms');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const body = await c.req.json<{ label?: string; target_date?: string }>().catch(() => ({}) as never);
  const label = (body.label || '').trim();
  if (!label) return c.json({ success: false, error: '名前を入れてください' }, 400);
  if (label.length > MAX_LABEL) {
    return c.json({ success: false, error: `名前は${MAX_LABEL}文字までです` }, 400);
  }
  if (!validDate(body.target_date)) {
    return c.json({ success: false, error: '日付が正しくありません' }, 400);
  }
  const goal = await putLmsGoal(c.env.DB, gate.friend.id, label, body.target_date);
  return c.json({ success: true, goal });
});

/** 既定（共通テスト）に戻す。 */
lms.delete('/api/lms/goal', async (c) => {
  const gate = await requireStudent(c, 'lms');
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  await deleteLmsGoal(c.env.DB, gate.friend.id);
  return c.json({ success: true, goal: null });
});
