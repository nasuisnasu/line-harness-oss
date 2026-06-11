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
import { notifyScenarioEnrolled } from '../services/discord-notify.js';
import { processStepDeliveries } from '../services/step-delivery.js';
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
    submitLabel: row.submit_label ?? null,
    saveToMetadata: Boolean(row.save_to_metadata),
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
    const items = await getForms(c.env.DB);
    // Admin listing includes answer keys so editors can review/test forms.
    return c.json({ success: true, data: items.map((f) => serializeForm(f, { includeAnswers: true })) });
  } catch (err) {
    console.error('GET /api/forms error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

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
      submitLabel?: string | null;
      saveToMetadata?: boolean;
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
      submitLabel: body.submitLabel ?? null,
      saveToMetadata: body.saveToMetadata,
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
      submitLabel?: string | null;
      saveToMetadata?: boolean;
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
      submitLabel: body.submitLabel,
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

    const data = submissions.map((s) => ({
      ...serializeSubmission(s),
      friendName: s.friend_id ? (friendNameMap.get(s.friend_id) ?? null) : null,
    }));
    return c.json({ success: true, data });
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

    // Side effects (best-effort, don't fail the request)
    if (friendId) {
      const db = c.env.DB;
      const now = jstNow();

      const sideEffects: Promise<unknown>[] = [];

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
              sideEffects.push(addTagToFriend(db, friendId, tid));
            }
          }
        }
      }

      // Pass / Fail tag from grading
      if (grade?.passed === true && form.pass_tag_id) {
        sideEffects.push(addTagToFriend(db, friendId, form.pass_tag_id));
      } else if (grade?.passed === false && form.fail_tag_id) {
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

      // Fire scenario delivery immediately so the user doesn't wait for next 5-min cron tick.
      if (form.on_submit_scenario_id) {
        const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
        c.executionCtx.waitUntil(
          processStepDeliveries(c.env.DB, lineClient, c.env.TRACKING_BASE_URL).catch((err) =>
            console.error('[forms.submit] immediate processStepDeliveries failed:', err),
          ),
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
