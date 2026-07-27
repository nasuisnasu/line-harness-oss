import { getFriendById, getScenarioById } from '@line-crm/db';

/**
 * Discord通知ヘルパー
 * URL未設定や送信失敗は無視する（best-effort）
 */
export async function notifyDiscord(webhookUrl: string | undefined, content: string): Promise<void> {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch {
    // ignore
  }
}

/** イベント予約通知 */
export async function notifyEventBooked(
  webhookUrl: string | undefined,
  args: {
    eventName: string;
    friendName: string;
    startAt: string; // ISO
    zoomUrl?: string | null;
    formData?: Record<string, unknown> | null;
  },
): Promise<void> {
  if (!webhookUrl) return;
  try {
    const start = new Date(args.startAt);
    const jst = new Date(start.getTime() + 9 * 60 * 60_000);
    const dt = `${jst.getUTCFullYear()}/${String(jst.getUTCMonth() + 1).padStart(2, '0')}/${String(jst.getUTCDate()).padStart(2, '0')} ${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
    const lines = [
      `📅 **新規予約**: ${args.eventName}`,
      `👤 ${args.friendName}`,
      `🕒 ${dt}`,
    ];
    if (args.zoomUrl) lines.push(`🔗 ${args.zoomUrl}`);
    if (args.formData && Object.keys(args.formData).length > 0) {
      lines.push('📝 回答:');
      for (const [k, v] of Object.entries(args.formData)) {
        const val = Array.isArray(v) ? v.join(', ') : (typeof v === 'string' ? v : JSON.stringify(v));
        lines.push(`　• ${k}: ${val}`);
      }
    }
    await notifyDiscord(webhookUrl, lines.join('\n'));
  } catch {
    // ignore
  }
}

/** フォーム回答通知 */
export async function notifyFormSubmitted(
  webhookUrl: string | undefined,
  args: {
    formName: string;
    friendName: string;
    /** Field definitions, used to show labels instead of raw field names. */
    fields?: Array<{ name: string; label?: string }> | null;
    data: Record<string, unknown>;
  },
): Promise<void> {
  if (!webhookUrl) return;
  try {
    const labelOf = new Map((args.fields ?? []).map((f) => [f.name, f.label || f.name]));
    const lines = [`📝 **新規応募**: ${args.formName}`, `👤 ${args.friendName}`, ''];
    for (const [k, v] of Object.entries(args.data)) {
      const val = Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : JSON.stringify(v);
      if (val === '') continue;
      lines.push(`**${labelOf.get(k) ?? k}**`);
      lines.push(val);
    }
    // Discord hard-caps a message at 2000 characters.
    let content = lines.join('\n');
    if (content.length > 1900) content = `${content.slice(0, 1900)}\n…(省略)`;
    await notifyDiscord(webhookUrl, content);
  } catch {
    // ignore
  }
}

/** シナリオ発火通知 */
export async function notifyScenarioEnrolled(
  webhookUrl: string | undefined,
  db: D1Database,
  friendId: string,
  scenarioId: string,
): Promise<void> {
  if (!webhookUrl) return;
  try {
    const [friend, scenario] = await Promise.all([
      getFriendById(db, friendId),
      getScenarioById(db, scenarioId),
    ]);
    const friendName = friend?.display_name ?? friend?.line_user_id ?? '不明';
    const scenarioName = scenario?.name ?? '(削除されたシナリオ)';
    await notifyDiscord(webhookUrl, `🚀 シナリオ発火: **${scenarioName}** → ${friendName}`);
  } catch {
    // ignore
  }
}
