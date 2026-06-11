import { jstNow } from './utils.js';
// =============================================================================
// Forms — Survey / questionnaire system (L-step 回答フォーム equivalent)
// =============================================================================

export type FormType = 'generic' | 'daily_report' | 'test';

export interface Form {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  fields: string; // JSON string of FormField[]
  on_submit_tag_id: string | null;
  on_submit_scenario_id: string | null;
  on_submit_message: string | null;
  submit_label: string | null;
  save_to_metadata: number;
  submit_once: number;
  is_active: number;
  submit_count: number;
  form_type: FormType;
  correct_answers: string | null; // JSON: { [fieldName]: string | string[] }
  passing_score: number | null;
  pass_tag_id: string | null;
  fail_tag_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FormSubmission {
  id: string;
  form_id: string;
  friend_id: string | null;
  data: string; // JSON string
  score: number | null;
  max_score: number | null;
  passed: number | null;
  created_at: string;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function getForms(db: D1Database): Promise<Form[]> {
  const result = await db
    .prepare(`SELECT * FROM forms ORDER BY created_at DESC`)
    .all<Form>();
  return result.results;
}

export async function getFormById(db: D1Database, id: string): Promise<Form | null> {
  return db
    .prepare(`SELECT * FROM forms WHERE id = ?`)
    .bind(id)
    .first<Form>();
}

export interface CreateFormInput {
  name: string;
  displayName?: string | null;
  description?: string | null;
  fields: string; // JSON string
  onSubmitTagId?: string | null;
  onSubmitScenarioId?: string | null;
  onSubmitMessage?: string | null;
  submitLabel?: string | null;
  saveToMetadata?: boolean;
  submitOnce?: boolean;
  formType?: FormType;
  correctAnswers?: string | null;
  passingScore?: number | null;
  passTagId?: string | null;
  failTagId?: string | null;
}

export async function createForm(db: D1Database, input: CreateFormInput): Promise<Form> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO forms
         (id, name, display_name, description, fields, on_submit_tag_id, on_submit_scenario_id,
          on_submit_message, submit_label, save_to_metadata, submit_once, is_active, submit_count,
          form_type, correct_answers, passing_score, pass_tag_id, fail_tag_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.name,
      input.displayName ?? null,
      input.description ?? null,
      input.fields,
      input.onSubmitTagId ?? null,
      input.onSubmitScenarioId ?? null,
      input.onSubmitMessage ?? null,
      input.submitLabel ?? null,
      input.saveToMetadata !== false ? 1 : 0,
      input.submitOnce ? 1 : 0,
      input.formType ?? 'generic',
      input.correctAnswers ?? null,
      input.passingScore ?? null,
      input.passTagId ?? null,
      input.failTagId ?? null,
      now,
      now,
    )
    .run();

  return (await getFormById(db, id))!;
}

export interface UpdateFormInput {
  name?: string;
  displayName?: string | null;
  description?: string | null;
  fields?: string;
  onSubmitTagId?: string | null;
  onSubmitScenarioId?: string | null;
  onSubmitMessage?: string | null;
  submitLabel?: string | null;
  saveToMetadata?: boolean;
  submitOnce?: boolean;
  isActive?: boolean;
  formType?: FormType;
  correctAnswers?: string | null;
  passingScore?: number | null;
  passTagId?: string | null;
  failTagId?: string | null;
}

export async function updateForm(
  db: D1Database,
  id: string,
  input: UpdateFormInput,
): Promise<Form | null> {
  const existing = await getFormById(db, id);
  if (!existing) return null;

  const now = jstNow();

  await db
    .prepare(
      `UPDATE forms
       SET name = ?,
           display_name = ?,
           description = ?,
           fields = ?,
           on_submit_tag_id = ?,
           on_submit_scenario_id = ?,
           on_submit_message = ?,
           submit_label = ?,
           save_to_metadata = ?,
           submit_once = ?,
           is_active = ?,
           form_type = ?,
           correct_answers = ?,
           passing_score = ?,
           pass_tag_id = ?,
           fail_tag_id = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.name ?? existing.name,
      'displayName' in input ? (input.displayName ?? null) : existing.display_name,
      'description' in input ? (input.description ?? null) : existing.description,
      input.fields ?? existing.fields,
      'onSubmitTagId' in input ? (input.onSubmitTagId ?? null) : existing.on_submit_tag_id,
      'onSubmitScenarioId' in input
        ? (input.onSubmitScenarioId ?? null)
        : existing.on_submit_scenario_id,
      'onSubmitMessage' in input ? (input.onSubmitMessage ?? null) : existing.on_submit_message,
      'submitLabel' in input ? (input.submitLabel ?? null) : existing.submit_label,
      'saveToMetadata' in input
        ? (input.saveToMetadata !== false ? 1 : 0)
        : existing.save_to_metadata,
      'submitOnce' in input ? (input.submitOnce ? 1 : 0) : existing.submit_once,
      'isActive' in input ? (input.isActive ? 1 : 0) : existing.is_active,
      input.formType ?? existing.form_type,
      'correctAnswers' in input ? (input.correctAnswers ?? null) : existing.correct_answers,
      'passingScore' in input ? (input.passingScore ?? null) : existing.passing_score,
      'passTagId' in input ? (input.passTagId ?? null) : existing.pass_tag_id,
      'failTagId' in input ? (input.failTagId ?? null) : existing.fail_tag_id,
      now,
      id,
    )
    .run();

  return getFormById(db, id);
}

export async function deleteForm(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM forms WHERE id = ?`).bind(id).run();
}

// ── Submissions ───────────────────────────────────────────────────────────────

export async function getFormSubmissions(
  db: D1Database,
  formId: string,
): Promise<FormSubmission[]> {
  const result = await db
    .prepare(
      `SELECT * FROM form_submissions WHERE form_id = ? ORDER BY created_at DESC`,
    )
    .bind(formId)
    .all<FormSubmission>();
  return result.results;
}

export interface CreateFormSubmissionInput {
  formId: string;
  friendId?: string | null;
  data: string; // JSON string
  score?: number | null;
  maxScore?: number | null;
  passed?: boolean | null;
}

export async function createFormSubmission(
  db: D1Database,
  input: CreateFormSubmissionInput,
): Promise<FormSubmission> {
  const id = crypto.randomUUID();
  const now = jstNow();

  const passedVal =
    input.passed === undefined || input.passed === null ? null : input.passed ? 1 : 0;

  await db
    .prepare(
      `INSERT INTO form_submissions (id, form_id, friend_id, data, score, max_score, passed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.formId,
      input.friendId ?? null,
      input.data,
      input.score ?? null,
      input.maxScore ?? null,
      passedVal,
      now,
    )
    .run();

  // Increment submit_count
  await db
    .prepare(`UPDATE forms SET submit_count = submit_count + 1, updated_at = ? WHERE id = ?`)
    .bind(now, input.formId)
    .run();

  return (await db
    .prepare(`SELECT * FROM form_submissions WHERE id = ?`)
    .bind(id)
    .first<FormSubmission>())!;
}

// ── Grading ──────────────────────────────────────────────────────────────────

export interface GradeResult {
  score: number;
  maxScore: number;
  passed: boolean | null;
  /** Per-question result for showing feedback to the student. */
  details: Array<{ name: string; correct: boolean; expected: unknown; actual: unknown }>;
}

/**
 * Compare the student's answers against the form's correct_answers JSON
 * and return a graded result.
 *
 * Comparison rules:
 *   - string vs string  → strict equality
 *   - string[] vs string[] → set-equality (order doesn't matter)
 *   - string[] vs string → any match counts (lets you list multiple acceptable answers)
 *
 * If passing_score is set, `passed` is `score/maxScore*100 >= passing_score`.
 * Otherwise `passed` is null.
 */
export function gradeSubmission(
  form: Pick<Form, 'correct_answers' | 'passing_score'>,
  data: Record<string, unknown>,
): GradeResult {
  const correct = form.correct_answers
    ? (JSON.parse(form.correct_answers) as Record<string, string | string[]>)
    : {};

  const details: GradeResult['details'] = [];
  let score = 0;
  let maxScore = 0;

  for (const [name, expected] of Object.entries(correct)) {
    maxScore++;
    const actual = data[name];
    const isCorrect = compareAnswer(expected, actual);
    if (isCorrect) score++;
    details.push({ name, correct: isCorrect, expected, actual });
  }

  let passed: boolean | null = null;
  if (form.passing_score !== null && maxScore > 0) {
    const pct = (score / maxScore) * 100;
    passed = pct >= form.passing_score;
  }

  return { score, maxScore, passed, details };
}

function compareAnswer(expected: string | string[], actual: unknown): boolean {
  if (Array.isArray(expected)) {
    if (Array.isArray(actual)) {
      // set-equality
      const a = new Set(expected.map(String));
      const b = new Set(actual.map(String));
      if (a.size !== b.size) return false;
      for (const v of a) if (!b.has(v)) return false;
      return true;
    }
    // any-match (multiple acceptable single-value answers)
    return expected.map(String).includes(String(actual ?? ''));
  }
  return String(actual ?? '') === String(expected);
}
