/**
 * 受講生の目標日 — 単語テストと文法テストで共通
 *
 * どちらの画面にも上にカウントダウンが出る。既定は共通テストまでだが、
 * 生徒が自分の受験日・模試日に変えられる。**設定は1つで両方に効く。**
 *
 * 機能ごとに持たせない理由は `migrations/064_lms_goals.sql` に書いた。
 */

import { jstNow } from './utils';

export interface LmsGoal {
  friend_id: string;
  /** カウントダウンの見出し。「共通テスト」「早稲田入試」など */
  label: string;
  /** 'YYYY-MM-DD'（JST） */
  target_date: string;
  updated_at: string;
}

/** 未設定なら null。呼び出し側で既定（共通テスト）に倒す。 */
export async function getLmsGoal(db: D1Database, friendId: string): Promise<LmsGoal | null> {
  return await db
    .prepare(`SELECT * FROM lms_goals WHERE friend_id = ?`)
    .bind(friendId)
    .first<LmsGoal>();
}

/**
 * 保存。1人1件なので upsert。
 *
 * 日付の妥当性は呼び出し側で見る（ここは形だけ確認して弾く）。
 */
export async function putLmsGoal(
  db: D1Database,
  friendId: string,
  label: string,
  targetDate: string,
): Promise<LmsGoal> {
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO lms_goals (friend_id, label, target_date, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (friend_id) DO UPDATE
         SET label = ?2, target_date = ?3, updated_at = ?4`,
    )
    .bind(friendId, label, targetDate, now)
    .run();
  return { friend_id: friendId, label, target_date: targetDate, updated_at: now };
}

/** 既定（共通テスト）に戻す。行を消すだけ。 */
export async function deleteLmsGoal(db: D1Database, friendId: string): Promise<void> {
  await db.prepare(`DELETE FROM lms_goals WHERE friend_id = ?`).bind(friendId).run();
}
