import { Hono } from 'hono';
import { getLineAccountById } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { notifyDiscord } from '../services/discord-notify.js';
import type { Env } from '../index.js';

/**
 * UnivaPay 決済 → 予約券（payment_tickets）発行。
 *
 * 有料イベント（event_consultation_configs.requires_payment_ticket=1）は、
 * ここで発行された未使用の券がないと予約できない（events.ts のゲート参照）。
 *
 * フロー:
 *   決済ページ(strategy/) → UnivaPay 直課金(payment) → webhook で券を1枚発行
 *   → サンクスページが /api/public/pay/ticket?chargeId= で券番号を取得
 *   → 予約LIFF を ?slug=有料&ticket=券番号 で開く → 予約成立で券を消費
 *
 * 公開ルート（/api/public/*）は auth ミドルウェアで allow-list 済み。
 */
const pay = new Hono<Env>();

/** URLセーフなランダム券番号（24文字） */
function makeTicketId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += chars[bytes[i] % chars.length];
  return s;
}

/** UnivaPay の metadata（オブジェクト or "k:v,k:v" 文字列）から値を引く */
function metaGet(meta: unknown, key: string): string {
  if (!meta) return '';
  if (typeof meta === 'object') {
    const v = (meta as Record<string, unknown>)[key];
    return v == null ? '' : String(v);
  }
  if (typeof meta === 'string') {
    for (const pair of meta.split(',')) {
      const idx = pair.indexOf(':');
      if (idx > 0 && pair.slice(0, idx).trim() === key) return pair.slice(idx + 1).trim();
    }
  }
  return '';
}

// ──────────────────────────────────────────────────────────────────────────
// UnivaPay webhook — 決済成功で予約券を発行（charge_id で冪等）
// ──────────────────────────────────────────────────────────────────────────
pay.post('/api/public/pay/univapay-webhook', async (c) => {
  try {
    // 共有シークレット検証（?token= か Authorization: Bearer）。未設定なら検証スキップ。
    const secret = c.env.UNIVAPAY_WEBHOOK_SECRET;
    if (secret) {
      const q = c.req.query('token') ?? '';
      const auth = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
      if (q !== secret && auth !== secret) {
        return c.json({ error: 'unauthorized' }, 401);
      }
    }

    const ev = await c.req.json<any>().catch(() => ({}));
    const d = ev?.data ?? ev ?? {};
    const type = String(ev?.type ?? ev?.event ?? '').toLowerCase();
    const chargeId = String(d.id ?? d.charge_id ?? ev?.id ?? '').trim();
    const status = String(d.status ?? '').toLowerCase();
    const amount = Number(d.charged_amount ?? d.amount ?? d.requested_amount ?? 0) || 0;
    const meta = d.metadata ?? {};
    const slug = metaGet(meta, 'slug').slice(0, 120) || null;
    const name = (String(d.card_holder_name ?? d.customer_name ?? '') || metaGet(meta, 'name')).slice(0, 120) || null;
    const email = (String(d.email ?? d.customer_email ?? '') || metaGet(meta, 'email')).slice(0, 160) || null;
    const lineAccountId = metaGet(meta, 'line-account-id') || metaGet(meta, 'account') || null;
    const lineUid = metaGet(meta, 'lineuid') || metaGet(meta, 'line-uid') || '';
    // まとめ買い回数（例: 5回券なら metadata.uses=5）。1〜10にクランプ。
    const uses = Math.max(1, Math.min(10, parseInt(metaGet(meta, 'uses'), 10) || 1));

    const ok = /success|finished|complete/.test(type) || status === 'successful' || status === 'completed';

    if (chargeId && ok) {
      // charge_id 一意で冪等。既に券があれば何もしない。
      const existing = await c.env.DB
        .prepare(`SELECT id FROM payment_tickets WHERE charge_id = ?`)
        .bind(chargeId)
        .first<{ id: string }>();
      if (!existing) {
        const id = makeTicketId();
        await c.env.DB
          .prepare(
            `INSERT INTO payment_tickets
               (id, line_account_id, charge_id, amount, status, event_slug, name, email, line_user_id, uses_total, uses_remaining)
             VALUES (?, ?, ?, ?, 'unused', ?, ?, ?, ?, ?, ?)`,
          )
          .bind(id, lineAccountId, chargeId, amount, slug, name, email, lineUid || null, uses, uses)
          .run();

        const yen = amount ? `¥${amount.toLocaleString('ja-JP')}` : '';
        await notifyDiscord(
          c.env.PAY_DISCORD_WEBHOOK_URL || c.env.DISCORD_WEBHOOK_URL,
          [
            `💰 **決済が入りました** ${yen}`,
            name ? `氏名: ${name}` : '',
            email ? `メール: ${email}` : '',
            slug ? `対象: ${slug}` : '',
            uses > 1 ? `回数券: ${uses}回ぶん` : '',
            `受付番号: ${chargeId}`,
            `→ 予約券（${uses}回）を発行しました。予約が入ると📅通知が届きます`,
          ].filter(Boolean).join('\n'),
        );

        // 決済者のLINEに「予約はこちら」を送る（uidが取れていて対象イベントがあるときだけ）。
        // ユーザーは好きなタイミングでこのリンクから日程を予約できる（後から予約OK）。
        if (lineUid && slug) {
          try {
            const ev = await c.env.DB
              .prepare(`SELECT line_account_id FROM events WHERE slug = ?`)
              .bind(slug)
              .first<{ line_account_id: string | null }>();
            if (ev?.line_account_id) {
              const account = await getLineAccountById(c.env.DB, ev.line_account_id);
              if (account?.channel_access_token && account.liff_id) {
                const bookingUrl =
                  `https://liff.line.me/${account.liff_id}?page=event&slug=${encodeURIComponent(slug)}` +
                  `&liffId=${account.liff_id}&ticket=${id}`;
                const usesNote =
                  uses > 1
                    ? `こちらは${uses}回ぶんの回数券です。\n同じリンクから${uses}回まで予約できます（有効期限：ご購入から6ヶ月）。\n\n`
                    : '';
                const text =
                  'お申し込みありがとうございます！\n\n' +
                  '下記から戦略会議の日程をご予約ください。\n' +
                  'ご都合の良いタイミングでお選びいただけます。\n\n' +
                  usesNote +
                  bookingUrl;
                const line = new LineClient(account.channel_access_token);
                await line.pushMessage(lineUid, [{ type: 'text', text }]);
              }
            }
          } catch (e) {
            console.error('pay: booking-link push failed (continuing):', e);
          }
        }
      }
    }

    // UnivaPay には常に200（再送ループを避ける）
    return c.json({ ok: true });
  } catch (err) {
    console.error('POST /api/public/pay/univapay-webhook error:', err);
    // パース不能でも200で受け切る
    return c.json({ ok: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 券照会 — サンクスページが chargeId から券番号を引く（webhook 反映をポーリング）
// ──────────────────────────────────────────────────────────────────────────
pay.get('/api/public/pay/ticket', async (c) => {
  const chargeId = (c.req.query('chargeId') ?? '').trim();
  if (!chargeId) return c.json({ error: 'chargeId required' }, 400);
  const row = await c.env.DB
    .prepare(
      `SELECT id, status, event_slug, uses_total, uses_remaining,
              datetime(created_at, '+6 months') AS expires_at
         FROM payment_tickets WHERE charge_id = ?`,
    )
    .bind(chargeId)
    .first<{
      id: string;
      status: string;
      event_slug: string | null;
      uses_total: number;
      uses_remaining: number;
      expires_at: string;
    }>();
  if (!row) return c.json({ pending: true });
  return c.json({
    ticket: row.id,
    status: row.status,
    slug: row.event_slug ?? null,
    usesTotal: row.uses_total,
    usesRemaining: row.uses_remaining,
    expiresAt: row.expires_at,
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 残券照会 — 再入場用。strategyページが uid で「まだ使える券」を探す。
//   ?uid=<LINE userId>&slug=<イベントslug>
//   有効（残回数>0・6ヶ月以内・当該イベント or 汎用券）な券を1枚返す。
// ──────────────────────────────────────────────────────────────────────────
// POST /api/pay/grant-tickets — 審査通過券を手動発行（admin）
// 戦略会議の無料枠は「応募 → 選考 → 当選者だけ予約できる」ので、
// 決済を伴わない券をここで配る。決済経由の券と同じ仕組みに乗せている。
pay.post('/api/pay/grant-tickets', async (c) => {
  try {
    const body = await c.req.json<{
      slug: string;
      friendIds?: string[];
      lineUserIds?: string[];
      expiresInDays?: number;
    }>();
    if (!body.slug) return c.json({ success: false, error: 'slug is required' }, 400);

    // friendId → lineUserId に寄せる（券は line_user_id で引くため）
    const targets: { lineUserId: string; friendId: string | null }[] = [];
    for (const fid of body.friendIds ?? []) {
      const f = await c.env.DB.prepare(`SELECT id, line_user_id FROM friends WHERE id = ?`)
        .bind(fid).first<{ id: string; line_user_id: string }>();
      if (f?.line_user_id) targets.push({ lineUserId: f.line_user_id, friendId: f.id });
    }
    for (const uid of body.lineUserIds ?? []) {
      if (!targets.some((t) => t.lineUserId === uid)) targets.push({ lineUserId: uid, friendId: null });
    }
    if (targets.length === 0) return c.json({ success: false, error: 'no valid targets' }, 400);

    const issued: { lineUserId: string; ticket: string }[] = [];
    for (const t of targets) {
      // 同じ人に未使用券が残っていれば重複発行しない
      const dup = await c.env.DB
        .prepare(
          `SELECT id FROM payment_tickets
           WHERE line_user_id = ? AND event_slug = ? AND status = 'unused' AND uses_remaining > 0 LIMIT 1`,
        )
        .bind(t.lineUserId, body.slug)
        .first<{ id: string }>();
      if (dup) { issued.push({ lineUserId: t.lineUserId, ticket: dup.id }); continue; }

      const id = crypto.randomUUID().replace(/-/g, '');
      await c.env.DB
        .prepare(
          `INSERT INTO payment_tickets
             (id, charge_id, amount, status, event_slug, line_user_id, uses_total, uses_remaining)
           VALUES (?, ?, 0, 'unused', ?, ?, 1, 1)`,
        )
        .bind(id, `grant:${id}`, body.slug, t.lineUserId)
        .run();
      issued.push({ lineUserId: t.lineUserId, ticket: id });
    }
    return c.json({ success: true, data: { issued, count: issued.length } });
  } catch (err) {
    console.error('POST /api/pay/grant-tickets error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

pay.get('/api/public/pay/my-tickets', async (c) => {
  const uid = (c.req.query('uid') ?? '').trim();
  const slug = (c.req.query('slug') ?? '').trim();
  if (!uid) return c.json({ ticket: null });
  const row = await c.env.DB
    .prepare(
      `SELECT id, uses_remaining, datetime(created_at, '+6 months') AS expires_at
         FROM payment_tickets
        WHERE line_user_id = ?
          AND (event_slug = ? OR event_slug IS NULL)
          AND uses_remaining > 0
          AND datetime(created_at, '+6 months') > datetime('now', '+9 hours')
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .bind(uid, slug)
    .first<{ id: string; uses_remaining: number; expires_at: string }>();
  if (!row) return c.json({ ticket: null });
  return c.json({ ticket: row.id, usesRemaining: row.uses_remaining, expiresAt: row.expires_at });
});

export { pay };
