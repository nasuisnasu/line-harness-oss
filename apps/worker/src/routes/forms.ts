import { Hono } from 'hono';
import {
  getForms,
  getFormById,
  createForm,
  updateForm,
  deleteForm,
  getFormSubmissions,
  createFormSubmission,
  gradeSubmission,
  jstNow,
} from '@line-crm/db';
import { getFriendByLineUserId, getFriendById } from '@line-crm/db';
import { addTagToFriend, enrollFriendInScenario } from '@line-crm/db';
import type { Form as DbForm, FormSubmission as DbFormSubmission, FormType } from '@line-crm/db';
import { notifyFormSubmitted, notifyScenarioEnrolled } from '../services/discord-notify.js';
import { processStepDeliveries } from '../services/step-delivery.js';
import { applyTagRichMenu } from '../lib/tag-rich-menu.js';
import { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../index.js';

const forms = new Hono<Env>();

function serializeForm(row: DbForm, opts: { includeAnswers?: boolean } = {}) {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    fields: JSON.parse(row.fields || '[]') as unknown[],
    onSubmitTagId: row.on_submit_tag_id,
    onSubmitScenarioId: row.on_submit_scenario_id,
    onSubmitMessage: row.on_submit_message ?? null,
    submitLabel: row.submit_label ?? null,
    saveToMetadata: Boolean(row.save_to_metadata),
    submitOnce: Boolean(row.submit_once),
    lineAccountId: row.line_account_id ?? null,
    isActive: Boolean(row.is_active),
    submitCount: row.submit_count,
    formType: row.form_type,
    // Public/LIFF callers should NEVER see the answer key.
    correctAnswers: opts.includeAnswers
      ? (row.correct_answers ? JSON.parse(row.correct_answers) : null)
      : undefined,
    passingScore: row.passing_score,
    passTagId: row.pass_tag_id,
    failTagId: row.fail_tag_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeSubmission(row: DbFormSubmission) {
  return {
    id: row.id,
    formId: row.form_id,
    friendId: row.friend_id,
    data: JSON.parse(row.data || '{}') as Record<string, unknown>,
    score: row.score,
    maxScore: row.max_score,
    passed: row.passed === null ? null : Boolean(row.passed),
    createdAt: row.created_at,
  };
}

// GET /api/forms — list all forms (admin)
forms.get('/api/forms', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const items = await getForms(c.env.DB, lineAccountId ? { lineAccountId } : {});
    // Admin listing includes answer keys so editors can review/test forms.
    return c.json({ success: true, data: items.map((f) => serializeForm(f, { includeAnswers: true })) });
  } catch (err) {
    console.error('GET /api/forms error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});


/**
 * フォームに設定された「このイベントを予約済みなら応募させない」ゲート。
 * 戦略会議の無料枠は一人1回までなので、すでに参加した人を弾く用途。
 * キャンセル済みは「参加した」に数えない（実際には会えていないため）。
 */
async function isBlockedByBooking(
  db: D1Database,
  form: { block_if_booked_slugs?: string | null },
  friendId: string | null,
): Promise<boolean> {
  const raw = form.block_if_booked_slugs?.trim();
  if (!raw || !friendId) return false;
  const slugs = raw.split(',').map((x) => x.trim()).filter(Boolean);
  if (slugs.length === 0) return false;
  const ph = slugs.map(() => '?').join(',');
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM calendar_bookings b
       JOIN events e ON e.id = b.app_event_id
       WHERE b.friend_id = ? AND e.slug IN (${ph}) AND b.status IN ('confirmed','completed')
       LIMIT 1`,
    )
    .bind(friendId, ...slugs)
    .first<{ hit: number }>();
  return Boolean(row);
}

/** friendId / lineUserId のどちらからでも友だちを引き当てる（submit と同じフォールバック） */
async function resolveFriendId(
  db: D1Database,
  friendId: string | null | undefined,
  lineUserId: string | null | undefined,
): Promise<string | null> {
  let id = friendId ?? null;
  if (id && !(await getFriendById(db, id))) id = null;
  if (!id && lineUserId) {
    const f = await getFriendByLineUserId(db, lineUserId);
    id = f?.id ?? null;
  }
  return id;
}

// GET /api/forms/:id — get form (public, used by LIFF)
// Strips correct_answers so the answer key never reaches the client.
forms.get('/api/forms/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const form = await getFormById(c.env.DB, id);
    if (!form) {
      return c.json({ success: false, error: 'Form not found' }, 404);
    }
    return c.json({ success: true, data: serializeForm(form) });
  } catch (err) {
    console.error('GET /api/forms/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/forms/:id/last — this friend's most recent submission (public, used by LIFF)
// Lets a repeat respondent start from what they answered last time instead of
// retyping everything. Returns { data: null } when there is nothing to prefill.
forms.get('/api/forms/:id/last', async (c) => {
  try {
    const formId = c.req.param('id');
    const lineUserId = c.req.query('lineUserId');
    const rawFriendId = c.req.query('friendId');

    // Same stale-fallback chain as submit: trust the LIFF-cached UUID only if it
    // still resolves, otherwise look the friend up by their LINE user id.
    let friendId: string | null = rawFriendId ?? null;
    if (friendId && !(await getFriendById(c.env.DB, friendId))) {
      friendId = null;
    }
    if (!friendId && lineUserId) {
      const friend = await getFriendByLineUserId(c.env.DB, lineUserId);
      friendId = friend?.id ?? null;
    }
    if (!friendId) {
      return c.json({ success: true, data: null });
    }

    const row = await c.env.DB
      .prepare(
        `SELECT data, created_at FROM form_submissions
         WHERE form_id = ? AND friend_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(formId, friendId)
      .first<{ data: string; created_at: string }>();
    if (!row) {
      return c.json({ success: true, data: null });
    }

    return c.json({
      success: true,
      data: { data: JSON.parse(row.data || '{}'), submittedAt: row.created_at },
    });
  } catch (err) {
    console.error('GET /api/forms/:id/last error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/forms/:id/eligibility — この友だちが応募できるか（public, used by LIFF）
forms.get('/api/forms/:id/eligibility', async (c) => {
  try {
    const formId = c.req.param('id');
    const form = await getFormById(c.env.DB, formId);
    if (!form) return c.json({ success: false, error: 'Form not found' }, 404);
    const friendId = await resolveFriendId(c.env.DB, c.req.query('friendId'), c.req.query('lineUserId'));
    const blocked = await isBlockedByBooking(c.env.DB, form as never, friendId);
    const msg = (form as unknown as { block_message?: string | null }).block_message ?? null;
    return c.json({ success: true, data: { eligible: !blocked, message: blocked ? msg : null } });
  } catch (err) {
    console.error('GET /api/forms/:id/eligibility error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/forms/:id/admin — admin variant, includes correct_answers
forms.get('/api/forms/:id/admin', async (c) => {
  try {
    const id = c.req.param('id');
    const form = await getFormById(c.env.DB, id);
    if (!form) {
      return c.json({ success: false, error: 'Form not found' }, 404);
    }
    return c.json({ success: true, data: serializeForm(form, { includeAnswers: true }) });
  } catch (err) {
    console.error('GET /api/forms/:id/admin error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/forms — create form
forms.post('/api/forms', async (c) => {
  try {
    const body = await c.req.json<{
      name: string;
      displayName?: string | null;
      description?: string | null;
      fields?: unknown[];
      onSubmitTagId?: string | null;
      onSubmitScenarioId?: string | null;
      onSubmitMessage?: string | null;
      submitLabel?: string | null;
      saveToMetadata?: boolean;
      submitOnce?: boolean;
      lineAccountId?: string | null;
      formType?: FormType;
      correctAnswers?: Record<string, string | string[]> | null;
      passingScore?: number | null;
      passTagId?: string | null;
      failTagId?: string | null;
    }>();

    if (!body.name) {
      return c.json({ success: false, error: 'name is required' }, 400);
    }

    const form = await createForm(c.env.DB, {
      name: body.name,
      displayName: body.displayName ?? null,
      description: body.description ?? null,
      fields: JSON.stringify(body.fields ?? []),
      onSubmitTagId: body.onSubmitTagId ?? null,
      onSubmitScenarioId: body.onSubmitScenarioId ?? null,
      onSubmitMessage: body.onSubmitMessage ?? null,
      submitLabel: body.submitLabel ?? null,
      submitOnce: body.submitOnce,
      saveToMetadata: body.saveToMetadata,
      lineAccountId: body.lineAccountId ?? null,
      formType: body.formType ?? 'generic',
      correctAnswers: body.correctAnswers ? JSON.stringify(body.correctAnswers) : null,
      passingScore: body.passingScore ?? null,
      passTagId: body.passTagId ?? null,
      failTagId: body.failTagId ?? null,
    });

    return c.json({ success: true, data: serializeForm(form, { includeAnswers: true }) }, 201);
  } catch (err) {
    console.error('POST /api/forms error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/forms/:id — update form
forms.put('/api/forms/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      name?: string;
      displayName?: string | null;
      description?: string | null;
      fields?: unknown[];
      onSubmitTagId?: string | null;
      onSubmitScenarioId?: string | null;
      onSubmitMessage?: string | null;
      submitLabel?: string | null;
      saveToMetadata?: boolean;
      submitOnce?: boolean;
      lineAccountId?: string | null;
      isActive?: boolean;
      formType?: FormType;
      correctAnswers?: Record<string, string | string[]> | null;
      passingScore?: number | null;
      passTagId?: string | null;
      failTagId?: string | null;
    }>();

    const updated = await updateForm(c.env.DB, id, {
      name: body.name,
      displayName: 'displayName' in body ? body.displayName : undefined,
      description: body.description,
      fields: body.fields !== undefined ? JSON.stringify(body.fields) : undefined,
      onSubmitTagId: body.onSubmitTagId,
      onSubmitScenarioId: body.onSubmitScenarioId,
      onSubmitMessage: 'onSubmitMessage' in body ? body.onSubmitMessage : undefined,
      submitLabel: body.submitLabel,
      submitOnce: 'submitOnce' in body ? body.submitOnce : undefined,
      lineAccountId: 'lineAccountId' in body ? body.lineAccountId : undefined,
      saveToMetadata: body.saveToMetadata,
      isActive: body.isActive,
      formType: body.formType,
      correctAnswers: 'correctAnswers' in body
        ? (body.correctAnswers ? JSON.stringify(body.correctAnswers) : null)
        : undefined,
      passingScore: 'passingScore' in body ? body.passingScore : undefined,
      passTagId: 'passTagId' in body ? body.passTagId : undefined,
      failTagId: 'failTagId' in body ? body.failTagId : undefined,
    });

    if (!updated) {
      return c.json({ success: false, error: 'Form not found' }, 404);
    }

    return c.json({ success: true, data: serializeForm(updated, { includeAnswers: true }) });
  } catch (err) {
    console.error('PUT /api/forms/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/forms/:id
forms.delete('/api/forms/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const form = await getFormById(c.env.DB, id);
    if (!form) {
      return c.json({ success: false, error: 'Form not found' }, 404);
    }
    await deleteForm(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/forms/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/forms/:id/submissions — list submissions (with friend display name)
forms.get('/api/forms/:id/submissions', async (c) => {
  try {
    const id = c.req.param('id');
    const form = await getFormById(c.env.DB, id);
    if (!form) {
      return c.json({ success: false, error: 'Form not found' }, 404);
    }
    const submissions = await getFormSubmissions(c.env.DB, id);

    // Bulk-fetch friend names for non-null friendIds
    const friendIds = Array.from(new Set(submissions.map((s) => s.friend_id).filter((x): x is string => !!x)));
    const friendNameMap = new Map<string, string>();
    if (friendIds.length > 0) {
      const placeholders = friendIds.map(() => '?').join(',');
      const rows = await c.env.DB
        .prepare(`SELECT id, display_name FROM friends WHERE id IN (${placeholders})`)
        .bind(...friendIds)
        .all<{ id: string; display_name: string | null }>();
      for (const r of rows.results) {
        friendNameMap.set(r.id, r.display_name ?? '');
      }
    }

    // このフォームが「どのイベントの応募窓口か」を辿り、当選タグ（requires_tag_id）を得る。
    // 応募一覧でその場でチェック→当選タグ付与できるようにする。
    let winnerTagId: string | null = null;
    const cfg = await c.env.DB
      .prepare(`SELECT requires_tag_id FROM event_consultation_configs WHERE application_form_id = ? LIMIT 1`)
      .bind(id)
      .first<{ requires_tag_id: string | null }>();
    winnerTagId = cfg?.requires_tag_id ?? null;

    // 各応募者が当選タグを持っているか
    const wonSet = new Set<string>();
    if (winnerTagId && friendIds.length > 0) {
      const ph = friendIds.map(() => '?').join(',');
      const rows = await c.env.DB
        .prepare(`SELECT friend_id FROM friend_tags WHERE tag_id = ? AND friend_id IN (${ph})`)
        .bind(winnerTagId, ...friendIds)
        .all<{ friend_id: string }>();
      for (const r of rows.results) wonSet.add(r.friend_id);
    }

    const data = submissions.map((s) => ({
      ...serializeSubmission(s),
      friendName: s.friend_id ? (friendNameMap.get(s.friend_id) ?? null) : null,
      isWinner: s.friend_id ? wonSet.has(s.friend_id) : false,
    }));
    return c.json({ success: true, data, winnerTagId });
  } catch (err) {
    console.error('GET /api/forms/:id/submissions error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/forms/:id/submit — submit form (public, used by LIFF)
forms.post('/api/forms/:id/submit', async (c) => {
  try {
    const formId = c.req.param('id');
    const form = await getFormById(c.env.DB, formId);
    if (!form) {
      return c.json({ success: false, error: 'Form not found' }, 404);
    }
    if (!form.is_active) {
      return c.json({ success: false, error: 'This form is no longer accepting responses' }, 400);
    }

    const body = await c.req.json<{
      lineUserId?: string;
      friendId?: string;
      data?: Record<string, unknown>;
    }>();

    const submissionData = body.data ?? {};

    // Validate required fields
    const fields = JSON.parse(form.fields || '[]') as Array<{
      name: string;
      label: string;
      type: string;
      required?: boolean;
    }>;

    for (const field of fields) {
      if (field.required) {
        const val = submissionData[field.name];
        if (val === undefined || val === null || val === '') {
          return c.json(
            { success: false, error: `${field.label} は必須項目です` },
            400,
          );
        }
      }
    }

    // Resolve friend ID with stale-fallback chain:
    // 1. Use body.friendId if it exists in DB (LIFF localStorage UUID)
    // 2. If stale or missing, fall back to lineUserId lookup
    let friendId: string | null = body.friendId ?? null;
    if (friendId) {
      const friend = await getFriendById(c.env.DB, friendId);
      if (!friend) {
        console.warn(`[forms.submit] stale friendId=${friendId}, falling back to lineUserId`);
        friendId = null;
      }
    }
    if (!friendId && body.lineUserId) {
      const friend = await getFriendByLineUserId(c.env.DB, body.lineUserId);
      if (friend) {
        friendId = friend.id;
      }
    }

    // 予約履歴ゲート：すでに対象イベントに参加済みなら応募させない
    if (await isBlockedByBooking(c.env.DB, form as never, friendId)) {
      const msg = (form as unknown as { block_message?: string | null }).block_message
        ?? 'すでにご参加いただいているため、応募できません。';
      return c.json({ success: false, error: msg }, 403);
    }

    // 1人1回まで制限：既に同じ友達からの提出があれば「既に回答済み」を返す
    if (form.submit_once && friendId) {
      const existing = await c.env.DB
        .prepare(`SELECT id FROM form_submissions WHERE form_id = ? AND friend_id = ? LIMIT 1`)
        .bind(formId, friendId)
        .first<{ id: string }>();
      if (existing) {
        return c.json({
          success: true,
          data: { alreadySubmitted: true, message: '既に回答されています' },
        });
      }
    }

    // Grade if this is a test (form_type='test' with correct_answers)
    const grade = form.form_type === 'test' && form.correct_answers
      ? gradeSubmission(form, submissionData)
      : null;

    // Save submission (with score if graded)
    const submission = await createFormSubmission(c.env.DB, {
      formId,
      friendId,
      data: JSON.stringify(submissionData),
      score: grade?.score ?? null,
      maxScore: grade?.maxScore ?? null,
      passed: grade?.passed ?? null,
    });

    // Discord notification — same channel as event bookings. Non-blocking.
    c.executionCtx.waitUntil(
      (async () => {
        const friend = friendId ? await getFriendById(c.env.DB, friendId) : null;
        await notifyFormSubmitted(c.env.DISCORD_WEBHOOK_URL, {
          formName: form.display_name?.trim() || form.name,
          friendName: friend?.display_name ?? body.lineUserId ?? '(不明)',
          fields: JSON.parse(form.fields || '[]'),
          data: submissionData,
        });
      })().catch((err) => console.error('[forms.submit] discord notify failed:', err)),
    );

    // Side effects (best-effort, don't fail the request)
    if (friendId) {
      const db = c.env.DB;
      const now = jstNow();

      const sideEffects: Promise<unknown>[] = [];
      // 今回この提出で付いたタグ。タグ連動リッチメニューの引き当てに使う。
      const appliedTagIds: string[] = [];

      // Save response data to friend's metadata
      if (form.save_to_metadata) {
        sideEffects.push(
          (async () => {
            const friend = await getFriendById(db, friendId!);
            if (!friend) return;
            const existing = JSON.parse(friend.metadata || '{}') as Record<string, unknown>;
            const merged = { ...existing, ...submissionData };
            await db
              .prepare(`UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?`)
              .bind(JSON.stringify(merged), now, friendId)
              .run();
          })(),
        );
      }

      // Add tag (form-level)
      if (form.on_submit_tag_id) {
        appliedTagIds.push(form.on_submit_tag_id);
        sideEffects.push(addTagToFriend(db, friendId, form.on_submit_tag_id));
      }

      // Add per-option tags (field-level): 選択肢に応じたタグ付与
      const fullFields = JSON.parse(form.fields || '[]') as Array<{
        name: string;
        type: string;
        optionTags?: Record<string, string[]>;
      }>;
      for (const field of fullFields) {
        if (!field.optionTags) continue;
        const answer = submissionData[field.name];
        const selectedValues: string[] = Array.isArray(answer)
          ? (answer as string[])
          : (typeof answer === 'string' && answer ? [answer] : []);
        for (const v of selectedValues) {
          const tagIds = field.optionTags[v];
          if (Array.isArray(tagIds)) {
            for (const tid of tagIds) {
              appliedTagIds.push(tid);
              sideEffects.push(addTagToFriend(db, friendId, tid));
            }
          }
        }
      }

      // Pass / Fail tag from grading
      if (grade?.passed === true && form.pass_tag_id) {
        appliedTagIds.push(form.pass_tag_id);
        sideEffects.push(addTagToFriend(db, friendId, form.pass_tag_id));
      } else if (grade?.passed === false && form.fail_tag_id) {
        appliedTagIds.push(form.fail_tag_id);
        sideEffects.push(addTagToFriend(db, friendId, form.fail_tag_id));
      }

      // Enroll in scenario
      if (form.on_submit_scenario_id) {
        const scenarioId = form.on_submit_scenario_id;
        sideEffects.push(
          enrollFriendInScenario(db, friendId, scenarioId).then(() =>
            notifyScenarioEnrolled(c.env.DISCORD_WEBHOOK_URL, db, friendId, scenarioId),
          ),
        );
      }

      if (sideEffects.length > 0) {
        await Promise.allSettled(sideEffects);
      }

      // タグ連動リッチメニュー：受講登録フォームで「生徒」を選んだ人に受講生用メニューを出す。
      // タグ付けが終わってから引く（順番が逆だと、まだ付いていないタグで探すことになる）。
      c.executionCtx.waitUntil(
        applyTagRichMenu(db, friendId, appliedTagIds, c.env.LINE_CHANNEL_ACCESS_TOKEN),
      );

      // Fire scenario delivery immediately so the user doesn't wait for next 5-min cron tick.
      if (form.on_submit_scenario_id) {
        const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
        c.executionCtx.waitUntil(
          processStepDeliveries(c.env.DB, lineClient, c.env.TRACKING_BASE_URL).catch((err) =>
            console.error('[forms.submit] immediate processStepDeliveries failed:', err),
          ),
        );
      }

      // Send a plain-text reply if configured. Uses the friend's bound LINE account token.
      if (form.on_submit_message && form.on_submit_message.trim()) {
        const text = form.on_submit_message;
        c.executionCtx.waitUntil(
          (async () => {
            try {
              const friend = await getFriendById(c.env.DB, friendId);
              if (!friend) return;
              let token: string = c.env.LINE_CHANNEL_ACCESS_TOKEN;
              if (friend.line_account_id) {
                const { getLineAccountById } = await import('@line-crm/db');
                const acc = await getLineAccountById(c.env.DB, friend.line_account_id);
                if (acc) token = acc.channel_access_token;
              }
              const client = new LineClient(token);
              await client.pushTextMessage(friend.line_user_id, text);
              const logId = crypto.randomUUID();
              await c.env.DB
                .prepare(
                  `INSERT INTO messages_log (id, friend_id, direction, message_type, content, created_at)
                   VALUES (?, ?, 'outgoing', 'text', ?, ?)`,
                )
                .bind(logId, friend.id, text, jstNow())
                .run();
            } catch (err) {
              console.error('[forms.submit] on_submit_message push failed:', err);
            }
          })(),
        );
      }
    }

    // Return grade details to the LIFF so it can show pass/fail UI.
    return c.json({
      success: true,
      data: {
        ...serializeSubmission(submission),
        grade: grade
          ? {
              score: grade.score,
              maxScore: grade.maxScore,
              passed: grade.passed,
              details: grade.details,
            }
          : null,
      },
    }, 201);
  } catch (err) {
    console.error('POST /api/forms/:id/submit error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { forms };
