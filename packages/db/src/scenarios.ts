import { jstNow } from './utils.js';
export type ScenarioTriggerType = 'friend_add' | 'tag_added' | 'manual';
export type MessageType = 'text' | 'image' | 'flex';
export type FriendScenarioStatus = 'active' | 'paused' | 'completed';

export interface Scenario {
  id: string;
  line_account_id: string | null;
  name: string;
  description: string | null;
  trigger_type: ScenarioTriggerType;
  trigger_tag_id: string | null;
  is_active: number;
  /** Free-form group label for UI bucketing. NULL = 未分類. */
  group_name: string | null;
  /** Optional chained scenario id. Friend is enrolled here on completion. */
  next_scenario_id: string | null;
  created_at: string;
  updated_at: string;
}

export type StepDelayMode = 'relative' | 'days_at_time' | 'absolute';

export interface ScenarioStep {
  id: string;
  scenario_id: string;
  step_order: number;
  delay_minutes: number;
  /** Delivery timing mode.
   *   'relative'      → use delay_minutes (legacy)
   *   'days_at_time'  → use delay_days + delay_time (HH:MM JST). The
   *                     scheduler resolves to the next occurrence of that
   *                     wall-clock time `delay_days` days after enrollment;
   *                     if today's HH:MM has already passed, it rolls
   *                     forward by an additional day.
   */
  delay_mode: StepDelayMode;
  /** Days from enrollment (or last delivery) for `days_at_time` mode. */
  delay_days: number | null;
  /** HH:MM in JST for `days_at_time` mode. */
  delay_time: string | null;
  /** Absolute calendar moment (`YYYY-MM-DDTHH:MM`, JST) for `absolute` mode. */
  delay_at: string | null;
  message_type: MessageType;
  message_content: string;
  condition_type: string | null;
  condition_value: string | null;
  next_step_on_false: number | null;
  rich_menu_id: string | null;
  /** If set, this step was filled from a template. Lets the editor reopen
   *  in template-picker mode instead of raw JSON. */
  template_id: string | null;
  created_at: string;
}

export interface ScenarioWithSteps extends Scenario {
  steps: ScenarioStep[];
}

export interface FriendScenario {
  id: string;
  friend_id: string;
  scenario_id: string;
  current_step_order: number;
  status: FriendScenarioStatus;
  started_at: string;
  next_delivery_at: string | null;
  updated_at: string;
}

// ============================================================
// Scenario CRUD
// ============================================================

export type ScenarioWithStepCount = Scenario & { step_count: number };

export async function getScenarios(db: D1Database, lineAccountId?: string): Promise<ScenarioWithStepCount[]> {
  const where = lineAccountId ? `WHERE s.line_account_id = ?` : '';
  const result = await db
    .prepare(
      `SELECT s.*, COUNT(ss.id) as step_count
       FROM scenarios s
       LEFT JOIN scenario_steps ss ON s.id = ss.scenario_id
       ${where}
       GROUP BY s.id
       ORDER BY s.created_at DESC`,
    )
    .bind(...(lineAccountId ? [lineAccountId] : []))
    .all<ScenarioWithStepCount>();
  return result.results;
}

export async function getScenarioById(
  db: D1Database,
  id: string,
): Promise<ScenarioWithSteps | null> {
  const scenario = await db
    .prepare(`SELECT * FROM scenarios WHERE id = ?`)
    .bind(id)
    .first<Scenario>();

  if (!scenario) return null;

  const stepsResult = await db
    .prepare(
      `SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order ASC`,
    )
    .bind(id)
    .all<ScenarioStep>();

  return { ...scenario, steps: stepsResult.results };
}

export interface CreateScenarioInput {
  name: string;
  description?: string | null;
  triggerType: ScenarioTriggerType;
  triggerTagId?: string | null;
  lineAccountId?: string | null;
  groupName?: string | null;
}

export async function createScenario(
  db: D1Database,
  input: CreateScenarioInput,
): Promise<Scenario> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO scenarios (id, line_account_id, name, description, trigger_type, trigger_tag_id, is_active, group_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .bind(
      id,
      input.lineAccountId ?? null,
      input.name,
      input.description ?? null,
      input.triggerType,
      input.triggerTagId ?? null,
      input.groupName ?? null,
      now,
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM scenarios WHERE id = ?`)
    .bind(id)
    .first<Scenario>())!;
}

export type UpdateScenarioInput = Partial<
  Pick<Scenario, 'name' | 'description' | 'trigger_type' | 'trigger_tag_id' | 'is_active' | 'group_name' | 'next_scenario_id'>
>;

export async function updateScenario(
  db: D1Database,
  id: string,
  updates: UpdateScenarioInput,
): Promise<Scenario | null> {
  const now = jstNow();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.trigger_type !== undefined) {
    fields.push('trigger_type = ?');
    values.push(updates.trigger_type);
  }
  if (updates.trigger_tag_id !== undefined) {
    fields.push('trigger_tag_id = ?');
    values.push(updates.trigger_tag_id);
  }
  if (updates.is_active !== undefined) {
    fields.push('is_active = ?');
    values.push(updates.is_active);
  }
  if (updates.group_name !== undefined) {
    fields.push('group_name = ?');
    values.push(updates.group_name);
  }
  if (updates.next_scenario_id !== undefined) {
    fields.push('next_scenario_id = ?');
    values.push(updates.next_scenario_id);
  }

  if (fields.length === 0) {
    return db
      .prepare(`SELECT * FROM scenarios WHERE id = ?`)
      .bind(id)
      .first<Scenario>();
  }

  fields.push('updated_at = ?');
  values.push(now);
  values.push(id);

  await db
    .prepare(`UPDATE scenarios SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  return db
    .prepare(`SELECT * FROM scenarios WHERE id = ?`)
    .bind(id)
    .first<Scenario>();
}

export async function deleteScenario(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM scenarios WHERE id = ?`).bind(id).run();
}

// ============================================================
// Scenario Steps
// ============================================================

export interface CreateScenarioStepInput {
  scenarioId: string;
  stepOrder: number;
  delayMinutes?: number;
  delayMode?: StepDelayMode;
  delayDays?: number | null;
  delayTime?: string | null;
  /** Absolute calendar moment to fire at, used when delayMode === 'absolute'.
   *  Stored verbatim as `YYYY-MM-DDTHH:MM` (treated as JST). */
  delayAt?: string | null;
  messageType: MessageType;
  messageContent: string;
  conditionType?: string | null;
  conditionValue?: string | null;
  nextStepOnFalse?: number | null;
  richMenuId?: string | null;
  templateId?: string | null;
}

export async function createScenarioStep(
  db: D1Database,
  input: CreateScenarioStepInput,
): Promise<ScenarioStep> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, delay_mode, delay_days, delay_time, delay_at, message_type, message_content, condition_type, condition_value, next_step_on_false, rich_menu_id, template_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.scenarioId,
      input.stepOrder,
      input.delayMinutes ?? 0,
      input.delayMode ?? 'relative',
      input.delayDays ?? null,
      input.delayTime ?? null,
      input.delayAt ?? null,
      input.messageType,
      input.messageContent,
      input.conditionType ?? null,
      input.conditionValue ?? null,
      input.nextStepOnFalse ?? null,
      input.richMenuId ?? null,
      input.templateId ?? null,
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM scenario_steps WHERE id = ?`)
    .bind(id)
    .first<ScenarioStep>())!;
}

export type UpdateScenarioStepInput = Partial<
  Pick<ScenarioStep, 'step_order' | 'delay_minutes' | 'delay_mode' | 'delay_days' | 'delay_time' | 'delay_at' | 'message_type' | 'message_content' | 'condition_type' | 'condition_value' | 'next_step_on_false' | 'rich_menu_id' | 'template_id'>
>;

export async function updateScenarioStep(
  db: D1Database,
  id: string,
  updates: UpdateScenarioStepInput,
): Promise<ScenarioStep | null> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.step_order !== undefined) {
    fields.push('step_order = ?');
    values.push(updates.step_order);
  }
  if (updates.delay_minutes !== undefined) {
    fields.push('delay_minutes = ?');
    values.push(updates.delay_minutes);
  }
  if (updates.delay_mode !== undefined) {
    fields.push('delay_mode = ?');
    values.push(updates.delay_mode);
  }
  if (updates.delay_days !== undefined) {
    fields.push('delay_days = ?');
    values.push(updates.delay_days);
  }
  if (updates.delay_time !== undefined) {
    fields.push('delay_time = ?');
    values.push(updates.delay_time);
  }
  if (updates.delay_at !== undefined) {
    fields.push('delay_at = ?');
    values.push(updates.delay_at);
  }
  if (updates.template_id !== undefined) {
    fields.push('template_id = ?');
    values.push(updates.template_id);
  }
  if (updates.message_type !== undefined) {
    fields.push('message_type = ?');
    values.push(updates.message_type);
  }
  if (updates.message_content !== undefined) {
    fields.push('message_content = ?');
    values.push(updates.message_content);
  }
  if (updates.condition_type !== undefined) {
    fields.push('condition_type = ?');
    values.push(updates.condition_type);
  }
  if (updates.condition_value !== undefined) {
    fields.push('condition_value = ?');
    values.push(updates.condition_value);
  }
  if (updates.next_step_on_false !== undefined) {
    fields.push('next_step_on_false = ?');
    values.push(updates.next_step_on_false);
  }
  if (updates.rich_menu_id !== undefined) {
    fields.push('rich_menu_id = ?');
    values.push(updates.rich_menu_id);
  }

  if (fields.length > 0) {
    values.push(id);
    await db
      .prepare(`UPDATE scenario_steps SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  return db
    .prepare(`SELECT * FROM scenario_steps WHERE id = ?`)
    .bind(id)
    .first<ScenarioStep>();
}

export async function deleteScenarioStep(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM scenario_steps WHERE id = ?`).bind(id).run();
}

export async function getScenarioSteps(
  db: D1Database,
  scenarioId: string,
): Promise<ScenarioStep[]> {
  const result = await db
    .prepare(
      `SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order ASC`,
    )
    .bind(scenarioId)
    .all<ScenarioStep>();
  return result.results;
}

// ============================================================
// Delivery scheduling
// ============================================================

/**
 * Compute the JST-formatted `next_delivery_at` timestamp for a step,
 * respecting `delay_mode`:
 *
 *   - 'relative'      → now + delay_minutes
 *   - 'days_at_time'  → today + delay_days, set wall-clock to delay_time
 *                       (HH:MM JST). If that target is already in the
 *                       past relative to "now", push another day forward
 *                       so we never schedule a delivery for a moment that
 *                       has already elapsed.
 *
 * Falls back to the relative path when the absolute fields are not fully
 * populated, so partially-saved rows can't deadlock the scheduler.
 */
export function computeStepNextDeliveryAt(step: {
  delay_minutes: number;
  delay_mode?: StepDelayMode | null;
  delay_days?: number | null;
  delay_time?: string | null;
  delay_at?: string | null;
}): string {
  const mode: StepDelayMode = (step.delay_mode as StepDelayMode | undefined) ?? 'relative';

  // Absolute mode: fire at the operator-chosen calendar moment regardless of
  // when the friend enrolled. Treat the input as JST. If the moment has
  // already passed (e.g., enrolled after the launch time), schedule for
  // "now" so the message goes out on the next scheduler tick rather than
  // sitting forever in the past.
  if (mode === 'absolute' && step.delay_at) {
    const at = String(step.delay_at).trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(at);
    if (m) {
      const [, y, mo, d, hh, mm] = m;
      const target = new Date(Date.UTC(
        parseInt(y!, 10), parseInt(mo!, 10) - 1, parseInt(d!, 10),
        parseInt(hh!, 10), parseInt(mm!, 10), 0, 0,
      ));
      const nowJst = new Date(Date.now() + 9 * 60 * 60_000);
      // target is in UTC fields but represents JST wall-clock — both sides
      // use the +9h trick so direct comparison works.
      const fireAt = target.getTime() <= nowJst.getTime() ? nowJst : target;
      return fireAt.toISOString().slice(0, -1) + '+09:00';
    }
  }

  if (mode === 'days_at_time' && step.delay_days != null && step.delay_time) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(step.delay_time);
    if (m) {
      const hh = Math.min(23, Math.max(0, parseInt(m[1]!, 10)));
      const mm = Math.min(59, Math.max(0, parseInt(m[2]!, 10)));
      const nowJst = new Date(Date.now() + 9 * 60 * 60_000);
      const target = new Date(nowJst.getTime());
      target.setUTCDate(nowJst.getUTCDate() + step.delay_days);
      target.setUTCHours(hh, mm, 0, 0);
      if (target.getTime() <= nowJst.getTime()) {
        target.setUTCDate(target.getUTCDate() + 1);
      }
      return target.toISOString().slice(0, -1) + '+09:00';
    }
  }
  return new Date(Date.now() + 9 * 60 * 60_000 + (step.delay_minutes || 0) * 60_000)
    .toISOString().slice(0, -1) + '+09:00';
}

// ============================================================
// Friend Scenario Enrollments
// ============================================================

export async function enrollFriendInScenario(
  db: D1Database,
  friendId: string,
  scenarioId: string,
): Promise<FriendScenario> {
  const id = crypto.randomUUID();
  const now = jstNow();

  // Pull all steps so we can skip past absolute-time steps for late enrollees.
  // For relative / days_at_time steps the original first-step semantics still
  // apply — those compute against "now" anyway, so there's nothing to skip.
  const stepsResult = await db
    .prepare(
      `SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order ASC`,
    )
    .bind(scenarioId)
    .all<ScenarioStep>();
  const steps = stepsResult.results;

  // A scenario with no steps is immediately completed — no stuck active enrollment.
  if (steps.length === 0) {
    await db
      .prepare(
        `INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at, next_delivery_at, updated_at)
         VALUES (?, ?, ?, 0, 'completed', ?, NULL, ?)`,
      )
      .bind(id, friendId, scenarioId, now, now)
      .run();

    return (await db
      .prepare(`SELECT * FROM friend_scenarios WHERE id = ?`)
      .bind(id)
      .first<FriendScenario>())!;
  }

  // Skip absolute-time steps whose delay_at has already passed. The next
  // future step (or the first step if all are non-absolute) becomes the
  // entry point. current_step_order is set to (entry.step_order - 1) so the
  // delivery loop's `s.step_order > current_step_order` finder picks it up.
  const nowMs = Date.now();
  let entryStep = steps[0];
  let entryIdx = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.delay_mode === 'absolute' && s.delay_at) {
      const computedIso = computeStepNextDeliveryAt(s);
      const computedMs = new Date(computedIso).getTime();
      // computeStepNextDeliveryAt returns "now" for past absolute targets;
      // a tight window around now still counts as "past".
      if (computedMs - nowMs <= 1000) {
        // past — keep scanning
        continue;
      }
    }
    entryStep = s;
    entryIdx = i;
    break;
  }

  // If every step was an already-past absolute step, mark the enrollment
  // completed instantly so it doesn't sit in active limbo.
  const allPast = entryIdx === 0 && steps.every((s) => s.delay_mode === 'absolute' && s.delay_at && new Date(computeStepNextDeliveryAt(s)).getTime() - nowMs <= 1000);
  if (allPast) {
    await db
      .prepare(
        `INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at, next_delivery_at, updated_at)
         VALUES (?, ?, ?, ?, 'completed', ?, NULL, ?)`,
      )
      .bind(id, friendId, scenarioId, steps[steps.length - 1].step_order, now, now)
      .run();
    return (await db
      .prepare(`SELECT * FROM friend_scenarios WHERE id = ?`)
      .bind(id)
      .first<FriendScenario>())!;
  }

  const nextDeliveryAt = computeStepNextDeliveryAt(entryStep);
  const startCurrentOrder = entryStep.step_order - 1;

  await db
    .prepare(
      `INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at, next_delivery_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .bind(id, friendId, scenarioId, startCurrentOrder, now, nextDeliveryAt, now)
    .run();

  return (await db
    .prepare(`SELECT * FROM friend_scenarios WHERE id = ?`)
    .bind(id)
    .first<FriendScenario>())!;
}

export async function getFriendScenariosDueForDelivery(
  db: D1Database,
  now: string,
): Promise<FriendScenario[]> {
  // Fetch all active scenarios with a delivery time, then filter by epoch comparison
  // to handle mixed timestamp formats (Z and +09:00) during migration
  const result = await db
    .prepare(
      `SELECT * FROM friend_scenarios
       WHERE status = 'active'
         AND next_delivery_at IS NOT NULL`,
    )
    .all<FriendScenario>();
  const nowMs = new Date(now).getTime();
  return result.results
    .filter((fs) => new Date(fs.next_delivery_at!).getTime() <= nowMs)
    .sort((a, b) => new Date(a.next_delivery_at!).getTime() - new Date(b.next_delivery_at!).getTime());
}

export async function advanceFriendScenario(
  db: D1Database,
  id: string,
  nextStepOrder: number,
  nextDeliveryAt?: string | null,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE friend_scenarios
       SET current_step_order = ?,
           next_delivery_at = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(nextStepOrder, nextDeliveryAt ?? null, now, id)
    .run();
}

export async function completeFriendScenario(
  db: D1Database,
  id: string,
): Promise<void> {
  const now = jstNow();
  // Read the row first so we can chain to `next_scenario_id` after marking
  // it complete. Order matters: mark complete → enroll into the next one.
  // If chaining fails (deleted scenario, etc.) the friend stays at
  // `completed` rather than re-running the just-finished one.
  const fs = await db
    .prepare(`SELECT friend_id, scenario_id FROM friend_scenarios WHERE id = ?`)
    .bind(id)
    .first<{ friend_id: string; scenario_id: string }>();

  await db
    .prepare(
      `UPDATE friend_scenarios
       SET status = 'completed',
           next_delivery_at = NULL,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(now, id)
    .run();

  if (!fs) return;

  const scenario = await db
    .prepare(`SELECT next_scenario_id FROM scenarios WHERE id = ?`)
    .bind(fs.scenario_id)
    .first<{ next_scenario_id: string | null }>();
  const nextId = scenario?.next_scenario_id;
  if (!nextId || nextId === fs.scenario_id) return;

  // Idempotent: skip if the friend already has an active enrollment in the
  // next scenario (e.g. after manual fixes). Avoids accidentally re-enrolling
  // someone who's already mid-flow there.
  const existing = await db
    .prepare(`SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ? AND status = 'active'`)
    .bind(fs.friend_id, nextId)
    .first<{ id: string }>();
  if (existing) return;

  try {
    await enrollFriendInScenario(db, fs.friend_id, nextId);
  } catch (err) {
    console.error('[scenario chain] enroll into next failed:', err);
  }
}
