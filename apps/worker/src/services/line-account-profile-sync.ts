// LINE 公式アカウントの表示名・アイコンを LINE API から取り込む。
// /v2/bot/info を叩いて line_accounts.name と picture_url を更新する。
// cron からは「24時間以内に同期済みのアカウントはスキップ」して呼ばれる。
import { LineClient } from '@line-crm/line-sdk';
import { getLineAccounts, updateLineAccount, jstNow } from '@line-crm/db';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function syncLineAccountProfiles(
  db: D1Database,
  opts: { force?: boolean; accountId?: string } = {},
): Promise<{ updated: string[]; skipped: string[]; errors: { id: string; error: string }[] }> {
  const updated: string[] = [];
  const skipped: string[] = [];
  const errors: { id: string; error: string }[] = [];

  const accounts = await getLineAccounts(db);
  const now = Date.now();

  for (const acc of accounts) {
    if (opts.accountId && acc.id !== opts.accountId) continue;
    if (!acc.is_active) continue;
    if (!opts.force && acc.profile_synced_at) {
      const last = new Date(acc.profile_synced_at).getTime();
      if (!Number.isNaN(last) && now - last < ONE_DAY_MS) {
        skipped.push(acc.id);
        continue;
      }
    }
    try {
      const client = new LineClient(acc.channel_access_token);
      const info = await client.getBotInfo();
      const nextName = info.displayName?.trim();
      const nextPic = info.pictureUrl ?? null;
      const patch: Parameters<typeof updateLineAccount>[2] = {
        profile_synced_at: jstNow(),
      };
      if (nextName && nextName !== acc.name) patch.name = nextName;
      if (nextPic !== acc.picture_url) patch.picture_url = nextPic;
      await updateLineAccount(db, acc.id, patch);
      updated.push(acc.id);
    } catch (e) {
      errors.push({ id: acc.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { updated, skipped, errors };
}
