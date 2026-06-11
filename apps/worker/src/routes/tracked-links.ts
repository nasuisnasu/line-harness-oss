import { Hono } from 'hono';
import {
  getTrackedLinks,
  getTrackedLinkById,
  createTrackedLink,
  updateTrackedLink,
  deleteTrackedLink,
  recordLinkClick,
  getLinkClicks,
} from '@line-crm/db';
import { addTagToFriend, enrollFriendInScenario, getFriendById } from '@line-crm/db';
import type { TrackedLink } from '@line-crm/db';
import type { Env } from '../index.js';
import { notifyDiscord, notifyScenarioEnrolled } from '../services/discord-notify.js';

const trackedLinks = new Hono<Env>();

function serializeTrackedLink(row: TrackedLink, baseUrl: string) {
  return {
    id: row.id,
    name: row.name,
    originalUrl: row.original_url,
    trackingUrl: `${baseUrl}/t/${row.id}`,
    tagId: row.tag_id,
    scenarioId: row.scenario_id,
    lineAccountId: row.line_account_id ?? null,
    isActive: Boolean(row.is_active),
    clickCount: row.click_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getBaseUrl(c: { req: { url: string } }): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

// GET /api/tracked-links — list filtered to the selected LINE account
// when one is provided. Legacy rows (line_account_id NULL) stay visible
// from any account view so old links don't vanish silently.
trackedLinks.get('/api/tracked-links', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId') ?? undefined;
    const items = await getTrackedLinks(c.env.DB, { lineAccountId });
    const base = getBaseUrl(c);
    return c.json({ success: true, data: items.map((item) => serializeTrackedLink(item, base)) });
  } catch (err) {
    console.error('GET /api/tracked-links error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/tracked-links/:id — get single with click details
trackedLinks.get('/api/tracked-links/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const link = await getTrackedLinkById(c.env.DB, id);
    if (!link) {
      return c.json({ success: false, error: 'Tracked link not found' }, 404);
    }
    const clicks = await getLinkClicks(c.env.DB, id);
    const base = getBaseUrl(c);
    return c.json({
      success: true,
      data: {
        ...serializeTrackedLink(link, base),
        clicks: clicks.map((click) => ({
          id: click.id,
          friendId: click.friend_id,
          friendDisplayName: click.friend_display_name,
          clickedAt: click.clicked_at,
        })),
      },
    });
  } catch (err) {
    console.error('GET /api/tracked-links/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/tracked-links — create
trackedLinks.post('/api/tracked-links', async (c) => {
  try {
    const body = await c.req.json<{
      name: string;
      originalUrl: string;
      tagId?: string | null;
      scenarioId?: string | null;
      lineAccountId?: string | null;
    }>();

    if (!body.name || !body.originalUrl) {
      return c.json({ success: false, error: 'name and originalUrl are required' }, 400);
    }

    // Fall back to query param so the caller can pass it via the same
    // mechanism used by other list/create endpoints.
    const lineAccountId = body.lineAccountId ?? c.req.query('lineAccountId') ?? null;

    const link = await createTrackedLink(c.env.DB, {
      name: body.name,
      originalUrl: body.originalUrl,
      tagId: body.tagId ?? null,
      scenarioId: body.scenarioId ?? null,
      lineAccountId,
    });

    const base = getBaseUrl(c);
    return c.json({ success: true, data: serializeTrackedLink(link, base) }, 201);
  } catch (err) {
    console.error('POST /api/tracked-links error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/tracked-links/:id — partial update (name / originalUrl /
// tagId / scenarioId / isActive). Only fields present in the body are
// written so callers can rename without losing the other settings.
trackedLinks.put('/api/tracked-links/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const link = await getTrackedLinkById(c.env.DB, id);
    if (!link) {
      return c.json({ success: false, error: 'Tracked link not found' }, 404);
    }
    const body = await c.req.json<{
      name?: string;
      originalUrl?: string;
      tagId?: string | null;
      scenarioId?: string | null;
      isActive?: boolean;
      lineAccountId?: string | null;
    }>();
    if (body.name !== undefined && !body.name.trim()) {
      return c.json({ success: false, error: 'name cannot be empty' }, 400);
    }
    if (body.originalUrl !== undefined && !body.originalUrl.trim()) {
      return c.json({ success: false, error: 'originalUrl cannot be empty' }, 400);
    }
    const updated = await updateTrackedLink(c.env.DB, id, body);
    if (!updated) return c.json({ success: false, error: 'update failed' }, 500);
    return c.json({ success: true, data: updated });
  } catch (err) {
    console.error('PUT /api/tracked-links/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/tracked-links/:id
trackedLinks.delete('/api/tracked-links/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const link = await getTrackedLinkById(c.env.DB, id);
    if (!link) {
      return c.json({ success: false, error: 'Tracked link not found' }, 404);
    }
    await deleteTrackedLink(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/tracked-links/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * Bot/クローラーのUser-Agentを判定する。
 * LINEのリンクプレビュー、SNSのOGP取得、検索エンジンのクローラなどを除外する。
 */
function isBotUserAgent(ua: string): boolean {
  const lower = ua.toLowerCase();
  const botSignals = [
    'line-linkverifier',  // LINE Bot - link verification
    'linepreview',
    'linebotwebhook',
    'facebookexternalhit',
    'facebot',
    'twitterbot',
    'slackbot',
    'discordbot',
    'telegrambot',
    'whatsapp',
    'bot/',
    'crawler',
    'spider',
    'preview',
    'fetch',
    'curl/',
    'wget/',
    'python-requests',
    'go-http-client',
    'okhttp',
    'java/',
    'apache-httpclient',
  ];
  return botSignals.some((sig) => lower.includes(sig));
}

// GET /t/:linkId — click tracking redirect (no auth, fast redirect)
trackedLinks.get('/t/:linkId', async (c) => {
  const linkId = c.req.param('linkId');
  const friendId = c.req.query('f') ?? null;

  // Look up the link first
  const link = await getTrackedLinkById(c.env.DB, linkId);

  if (!link || !link.is_active) {
    return c.json({ success: false, error: 'Link not found' }, 404);
  }

  // Bot/クローラーからのアクセスはリダイレクトのみ行い、クリックとして記録しない
  const userAgent = c.req.header('User-Agent') ?? '';
  if (isBotUserAgent(userAgent)) {
    return c.redirect(link.original_url, 302);
  }

  // Redirect immediately, run side-effects async
  const ctx = c.executionCtx as ExecutionContext;
  ctx.waitUntil(
    (async () => {
      try {
        // Record the click (returns null on duplicate by same friend)
        const recorded = await recordLinkClick(c.env.DB, linkId, friendId);

        // Discord通知（重複クリックの場合は通知しない）
        if (recorded) {
          let friendName = '不明';
          if (friendId) {
            const friend = await getFriendById(c.env.DB, friendId);
            if (friend) friendName = friend.display_name ?? friend.line_user_id;
          }
          await notifyDiscord(c.env.DISCORD_WEBHOOK_URL, `🔗 リンククリック: **${link.name}** ← ${friendName}`);
        }

        // Run automatic actions if a friend is identified
        if (friendId) {
          const actions: Promise<unknown>[] = [];

          if (link.tag_id) {
            actions.push(addTagToFriend(c.env.DB, friendId, link.tag_id));
          }

          if (link.scenario_id) {
            const scenarioId = link.scenario_id;
            actions.push(
              enrollFriendInScenario(c.env.DB, friendId, scenarioId).then(() =>
                notifyScenarioEnrolled(c.env.DISCORD_WEBHOOK_URL, c.env.DB, friendId, scenarioId),
              ),
            );
          }

          if (actions.length > 0) {
            await Promise.allSettled(actions);
          }
        }
      } catch (err) {
        console.error(`/t/${linkId} async tracking error:`, err);
      }
    })(),
  );

  return c.redirect(link.original_url, 302);
});

export { trackedLinks };
