/**
 * 目標日のカウントダウン — 単語テストと文法テストで共有
 *
 * 両方の画面の上に同じものが出る。**設定は1つで両方に効く**（サーバーに1件持つ）。
 * 既定は共通テストまで。生徒が自分の受験日・模試日に変えられる。
 *
 * 元は `vocab.ts` と `grammar.ts` にまったく同じ `catBar()` / `daysToExam()` が
 * 2つあった。片方だけ直すと必ずずれるのでここへ寄せた。
 *
 * ⚠️ 既定日（共通テスト）は**サーバーではなくここで作る。**
 *    サーバーが作ると、年が変わったときに直す場所が増える。
 */

import { CAT_PNG_BASE64 } from './vocab-cat.js';

export interface Goal {
  label: string;
  /** 'YYYY-MM-DD' */
  target_date: string;
}

const WD = ['日', '月', '火', '水', '木', '金', '土'];

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}

/** 次の共通テスト。「1月13日以降の最初の土曜日」に実施される。 */
export function defaultGoal(now = new Date()): Goal {
  const firstSatOnOrAfter13 = (year: number): Date => {
    const d = new Date(year, 0, 13);
    while (d.getDay() !== 6) d.setDate(d.getDate() + 1);
    return d;
  };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let exam = firstSatOnOrAfter13(today.getFullYear());
  if (exam < today) exam = firstSatOnOrAfter13(today.getFullYear() + 1);
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    label: '共通テスト',
    target_date: `${exam.getFullYear()}-${p(exam.getMonth() + 1)}-${p(exam.getDate())}`,
  };
}

/** 目標日までの日数と、表示用に整えた日付。 */
export function goalDays(goal: Goal, now = new Date()): { days: number; text: string } {
  const m = goal.target_date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { days: 0, text: goal.target_date };
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((t.getTime() - today.getTime()) / 86_400_000);
  // 曜日を改行で落とすと、その1文字だけの行ができて収まりが悪い。1行に収める。
  return {
    days,
    text: `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()}（${WD[t.getDay()]}）`,
  };
}

/**
 * ホームの上に出すカウントダウン。**押すと設定画面に行ける。**
 *
 * 押せることが分からないと誰も設定を見つけないので、右下に小さく印を出す。
 * **下線つきのリンク色にはしない。** カード全体が押せるので、
 * そこだけ別のリンクがあるように見えてしまう。
 */
export function goalBar(goal: Goal): string {
  const { days, text } = goalDays(goal);
  return `
<div class="v-cat" id="vGoalBar" role="button" tabindex="0">
  <span class="av"><img src="data:image/png;base64,${CAT_PNG_BASE64}" alt=""></span>
  <span class="say">
    <em>${esc(goal.label)}まで</em>
    <b>${days}<i>日</i></b>
  </span>
  <span class="dt">${text}<span class="ed">変更</span></span>
</div>`;
}

/** 設定画面の中身。シェルは呼び出し側（アプリごとに違う）で包む。 */
export function goalFormHtml(goal: Goal, isDefault: boolean): string {
  return `
<p class="v-sub">受験日や模試の日を入れると、単語テストと文法テストの両方に出ます。</p>
<label class="v-field">
  <span>名前</span>
  <input type="text" id="goalLabel" maxlength="20" value="${esc(goal.label)}"
    placeholder="早稲田入試 / 第2回模試 など">
</label>
<label class="v-field">
  <span>日付</span>
  <input type="date" id="goalDate" value="${esc(goal.target_date)}">
</label>
<p class="v-err v-hide" id="goalErr"></p>
<button class="v-go" id="goalSave">保存する</button>
${isDefault ? '' : '<button class="v-ghost" id="goalReset">共通テストに戻す</button>'}
<button class="v-switch" id="goalBack">戻る</button>`;
}

/** 入力を読む。おかしければエラー文言を返す。 */
export function readGoalForm(): { goal?: Goal; error?: string } {
  const label = (document.getElementById('goalLabel') as HTMLInputElement).value.trim();
  const date = (document.getElementById('goalDate') as HTMLInputElement).value;
  if (!label) return { error: '名前を入れてください' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: '日付を選んでください' };
  return { goal: { label, target_date: date } };
}
