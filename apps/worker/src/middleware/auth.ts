import type { Context, Next } from 'hono';
import type { Env } from '../index.js';

export async function authMiddleware(c: Context<Env>, next: Next): Promise<Response | void> {
  // Skip auth for the LINE webhook endpoint — it uses signature verification instead
  // Skip auth for OpenAPI docs — public documentation
  const path = new URL(c.req.url).pathname;
  if (
    path === '/webhook' ||
    path.startsWith('/webhook/') ||
    path === '/docs' ||
    path === '/openapi.json' ||
    path === '/api/affiliates/click' ||
    path.startsWith('/t/') ||
    path.startsWith('/api/liff/') ||
    path.startsWith('/auth/') ||
    path === '/api/integrations/stripe/webhook' ||
    path.match(/^\/api\/webhooks\/incoming\/[^/]+\/receive$/) ||
    path.match(/^\/api\/forms\/[^/]+\/submit$/) ||
    path.match(/^\/api\/forms\/[^/]+\/last$/) || // GET own last submission (public for LIFF prefill)
    path.match(/^\/api\/forms\/[^/]+\/eligibility$/) || // GET own eligibility (public for LIFF)
    path.match(/^\/api\/forms\/[^/]+$/) || // GET form definition (public for LIFF)
    path.startsWith('/uploads/') || // Public R2 image proxy — LINE servers fetch these
    path.startsWith('/api/public/') || // Public LIFF endpoints (event booking etc.)
    // 単語テストの生徒用API。Authorization を API_KEY ではなく LIFF の idToken に使うので
    // ここでは素通しし、routes/vocab.ts の requireStudent() で3段のゲートをかける。
    // /api/vocab/admin/* は素通ししない（API_KEY で守る）。
    (path.startsWith('/api/vocab/') && !path.startsWith('/api/vocab/admin')) ||
    // 授業教材の生徒用API。同じく Authorization を idToken に使うので素通しし、
    // routes/eijaku-materials.ts の requireStudent() で3段のゲートをかける。
    // /api/eijaku/students も同様に素通しし、ルート側で共有鍵（X-Shelf-Key）を確かめる。
    path.startsWith('/api/eijaku/')
  ) {
    return next();
  }

  // Bearer token (通常)
  const authHeader = c.req.header('Authorization');
  let token: string | null = null;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice('Bearer '.length);
  }
  // X-API-Key ヘッダ (multipart など)
  if (!token) token = c.req.header('X-API-Key') ?? null;
  // クエリパラメータ ?apiKey= (画像プレビューなど <img> タグ用)
  if (!token) token = c.req.query('apiKey') ?? null;

  if (!token || token !== c.env.API_KEY) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  return next();
}
