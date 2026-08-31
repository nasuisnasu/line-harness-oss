import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { LineClient } from '@line-crm/line-sdk';
import { processStepDeliveries } from './services/step-delivery.js';
import { processScheduledBroadcasts } from './services/broadcast.js';
import { processReminderDeliveries } from './services/reminder-delivery.js';
import { processBookingReminders } from './services/booking-reminders.js';
import { checkAccountHealth } from './services/ban-monitor.js';
import { syncLineAccountProfiles } from './services/line-account-profile-sync.js';
import { authMiddleware } from './middleware/auth.js';
import { webhook } from './routes/webhook.js';
import { friends } from './routes/friends.js';
import { tags } from './routes/tags.js';
import { scenarios } from './routes/scenarios.js';
import { broadcasts } from './routes/broadcasts.js';
import { users } from './routes/users.js';
import { lineAccounts } from './routes/line-accounts.js';
import { conversions } from './routes/conversions.js';
import { affiliates } from './routes/affiliates.js';
import { openapi } from './routes/openapi.js';
import { liffRoutes } from './routes/liff.js';
// Round 3 ルート
import { webhooks } from './routes/webhooks.js';
import { calendar } from './routes/calendar.js';
import { reminders } from './routes/reminders.js';
import { scoring } from './routes/scoring.js';
import { templates } from './routes/templates.js';
import { chats } from './routes/chats.js';
import { notifications } from './routes/notifications.js';
import { stripe } from './routes/stripe.js';
import { health } from './routes/health.js';
import { automations } from './routes/automations.js';
import { richMenus } from './routes/rich-menus.js';
import { trackedLinks } from './routes/tracked-links.js';
import { forms } from './routes/forms.js';
import { entryRoutes } from './routes/entry-routes.js';
import { uploads } from './routes/uploads.js';
import { actions } from './routes/actions.js';
import { autoReplies } from './routes/auto-replies.js';
import { events as eventsRoute } from './routes/events.js';
import { kpi } from './routes/kpi.js';
import { businessCalendar } from './routes/business-calendar.js';
import { pay } from './routes/pay.js';
import { vocab } from './routes/vocab.js';
import { grammar } from './routes/grammar.js';
import { bas } from './routes/bas.js';
import { bunkai } from './routes/bunkai.js';
import { lms } from './routes/lms.js';
import { eijakuMaterials } from './routes/eijaku-materials.js';
import { materialSubmissions } from './routes/material-submissions.js';

export type Env = {
  Bindings: {
    DB: D1Database;
    UPLOADS: R2Bucket;
    LINE_CHANNEL_SECRET: string;
    LINE_CHANNEL_ACCESS_TOKEN: string;
    API_KEY: string;
    LIFF_URL: string;
    LINE_CHANNEL_ID: string;
    LINE_LOGIN_CHANNEL_ID: string;
    LINE_LOGIN_CHANNEL_SECRET: string;
    DISCORD_WEBHOOK_URL?: string;
    TRACKING_BASE_URL?: string;
    GOOGLE_SA_JSON?: string;
    UNIVAPAY_WEBHOOK_SECRET?: string;
    PAY_DISCORD_WEBHOOK_URL?: string;  // 課金通知の専用Discord（未設定ならDISCORD_WEBHOOK_URLにフォールバック）
    // 単語テスト・文法テスト（受講生専用）で共用。3つとも設定されていないと
    // ゲートが fail closed になり、両方の生徒用APIが全部 503 を返す
    VOCAB_LOGIN_CHANNEL_ID?: string;   // 受講生専用OAの LINE Login チャネルID
    VOCAB_LINE_ACCOUNT_ID?: string;    // 受講生専用OAの line_accounts.id
    VOCAB_ALLOW_TAG_ID?: string;       // 受講生タグの tags.id
    // 教材の取り込みを回す OA。**受講生専用だけ。**未設定なら VOCAB_LINE_ACCOUNT_ID を見る。
    // どちらも無いときは取り込まない（fail closed）
    STUDENT_LINE_ACCOUNT_ID?: string;
    // 古文の品詞分解チェッカー。**このワーカーで唯一、従量課金のAPIを叩く機能。**
    // 未設定なら /api/bunkai/parse だけが 503 を返す（他の機能には影響しない）
    ANTHROPIC_API_KEY?: string;
    BUNKAI_MODEL?: string;             // 既定は claude-opus-5。費用を絞りたいとき差し替える
    BUNKAI_EFFORT?: string;            // low|medium|high|xhigh|max。既定 medium。費用の最大のつまみ
    BUNKAI_DAILY_LIMIT?: string;       // 1人1日に叩ける回数。既定 20
    // 授業教材の受け取り。eijakuniki.com 側の棚（ワーカー eijaku-ai）を呼ぶ
    SHELF?: Fetcher;                   // 棚へのサービスバインディング（1042回避のためURLでは呼ばない）
    SHELF_PUBLIC_URL?: string;         // 生徒に見せるファイルの公開URL（例: https://eijaku-ai.<sub>.workers.dev）
    SHELF_API_KEY?: string;            // 棚と共有する鍵
  };
};

const app = new Hono<Env>();

// CORS — allow all origins for MVP
app.use('*', cors({ origin: '*' }));

// Auth middleware — skips /webhook and /docs automatically
app.use('*', authMiddleware);

// Mount route groups — MVP & Round 2
app.route('/', webhook);
app.route('/', friends);
app.route('/', tags);
app.route('/', scenarios);
app.route('/', broadcasts);
app.route('/', users);
app.route('/', lineAccounts);
app.route('/', conversions);
app.route('/', affiliates);
app.route('/', openapi);
app.route('/', liffRoutes);

// Mount route groups — Round 3
app.route('/', webhooks);
app.route('/', calendar);
app.route('/', reminders);
app.route('/', scoring);
app.route('/', templates);
app.route('/', chats);
app.route('/', notifications);
app.route('/', stripe);
app.route('/', health);
app.route('/', automations);
app.route('/', richMenus);
app.route('/', trackedLinks);
app.route('/', forms);
app.route('/', entryRoutes);
app.route('/', uploads);
app.route('/', actions);
app.route('/', autoReplies);
app.route('/', eventsRoute);
app.route('/', kpi);
app.route('/', businessCalendar);
app.route('/', pay);
app.route('/', vocab);
app.route('/', grammar);
app.route('/', bas);
app.route('/', bunkai);
app.route('/', lms);
app.route('/', eijakuMaterials);
app.route('/', materialSubmissions);

// 404 fallback
app.notFound((c) => c.json({ success: false, error: 'Not found' }, 404));

// Scheduled handler for cron triggers
async function scheduled(
  _event: ScheduledEvent,
  env: Env['Bindings'],
  _ctx: ExecutionContext,
): Promise<void> {
  const lineClient = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);

  await Promise.allSettled([
    processStepDeliveries(env.DB, lineClient, env.TRACKING_BASE_URL),
    processScheduledBroadcasts(env.DB, lineClient, env.TRACKING_BASE_URL),
    processReminderDeliveries(env.DB, lineClient),
    processBookingReminders(env.DB),
    checkAccountHealth(env.DB),
    // LINE OA の表示名/アイコンを24時間に1回 LINE API から同期
    syncLineAccountProfiles(env.DB),
  ]);
}

export default {
  fetch: app.fetch,
  scheduled,
};
