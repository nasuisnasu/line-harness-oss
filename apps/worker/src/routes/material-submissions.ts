/**
 * 授業教材の提出（受講生 → 講師）
 *
 * 生徒が「次の授業で使いたい長文」を LIFF から出す。講師側（ローカルの Claude）が
 * pending を取りに来て、kyozai パイプラインに流し、終わったら done に落とす。
 *
 *   生徒 ──(idToken)──▶ POST /api/eijaku/submissions      … 出す
 *   講師 ──(API_KEY)──▶ GET  /api/material-submissions    … 溜まっているものを見る
 *   講師 ──(API_KEY)──▶ GET  /api/material-submissions/:id/files/:seq … 素材を取る
 *   講師 ──(API_KEY)──▶ PATCH /api/material-submissions/:id … 状態を進める
 *
 * 認証経路を混ぜないこと。生徒用は idToken（authMiddleware を素通りするので
 * requireStudent() がこのファイル唯一の壁）、講師用は API_KEY（`/api/material-`
 * で始まるパスは素通しリストに入れていないので、共通ミドルウェアが見てくれる）。
 * 生徒用を `/api/eijaku/` 配下に置いているのは、そこが素通しリストだから。
 * **講師用を `/api/eijaku/` に置いてはいけない。**鍵なしで全生徒の提出が読める。
 */

import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';
import { requireStudent, denied } from './eijaku-materials.js';
import { notifyDiscord } from '../services/discord-notify.js';
// 受け取れる形の判定はトーク経由と共通。片方だけ docx を足す、が起きないように1本にする。
import { resolveUploadType } from '../services/material-intake.js';

export const materialSubmissions = new Hono<Env>();

const MAX_FILES = 10;
const MAX_BYTES = 20 * 1024 * 1024; // 1ファイルあたり。長文1本の写真/PDFなら十分

/**
 * pending → building → done。失敗は failed、教材じゃなかったものは skipped。
 * 行は消さない（消すと同じ写真をまた拾う）。
 */
const STATUSES = ['pending', 'building', 'done', 'failed', 'skipped'] as const;
type Status = (typeof STATUSES)[number];

/**
 * multipart で上がってくるファイル。
 * このワーカーの型環境には DOM の `File` が無い（uploads.ts も同じ事情）ので、
 * 使う分だけを形で受ける。
 */
interface UploadFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isUploadFile(v: unknown): v is UploadFile {
  return typeof v === 'object' && v !== null && typeof (v as UploadFile).arrayBuffer === 'function';
}

interface SubmissionRow {
  id: string;
  friend_id: string;
  line_account_id: string | null;
  student_name: string;
  note: string | null;
  file_count: number;
  status: string;
  source: string;
  result_note: string | null;
  created_at: string;
  started_at: string | null;
  processed_at: string | null;
}

interface FileRow {
  submission_id: string;
  seq: number;
  r2_key: string;
  original_name: string | null;
  content_type: string;
  size: number;
}

// ── 生徒用 ──────────────────────────────────────────────────────────────────

/**
 * 提出する。誰の提出かは**サーバーが idToken から決める**。
 * フォームから生徒名を送らせない（他人の名前で出せてしまう）。
 */
materialSubmissions.post('/api/eijaku/submissions', async (c) => {
  const gate = await requireStudent(c);
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }

  try {
    const form = await c.req.formData();
    const files = (form.getAll('files') as unknown[]).filter(isUploadFile);
    if (files.length === 0) {
      return c.json({ success: false, error: '教材の写真かPDFを1つ以上選んでください' }, 400);
    }
    if (files.length > MAX_FILES) {
      return c.json({ success: false, error: `一度に出せるのは${MAX_FILES}枚までです` }, 400);
    }
    // 保存する前に全部見る。3枚目で弾かれて1・2枚目だけ R2 に残る、を避ける。
    const resolved: Array<{ file: UploadFile; ext: string; contentType: string }> = [];
    for (const f of files) {
      const t = resolveUploadType(f.name, f.type);
      if (!t) {
        return c.json(
          { success: false, error: '写真・PDF・Word（docx）・テキストのみ出せます' },
          400,
        );
      }
      if (f.size > MAX_BYTES) {
        return c.json({ success: false, error: '1ファイル20MBまでです' }, 400);
      }
      resolved.push({ file: f, ext: t.ext, contentType: t.contentType });
    }

    const note = ((form.get('note') as string | null) ?? '').trim().slice(0, 1000);
    const submissionId = crypto.randomUUID();
    const now = jstNow();

    // R2 を先に埋める。DB に行を作ってから R2 が失敗すると、
    // 「pending なのに素材が無い提出」が残って講師側が事故る。
    const stored: FileRow[] = [];
    for (let i = 0; i < resolved.length; i++) {
      const { file: f, ext, contentType } = resolved[i];
      const key = `submissions/${submissionId}/${i}.${ext}`;
      await c.env.UPLOADS.put(key, await f.arrayBuffer(), {
        httpMetadata: { contentType },
      });
      stored.push({
        submission_id: submissionId,
        seq: i,
        r2_key: key,
        original_name: f.name || null,
        content_type: contentType,
        size: f.size,
      });
    }

    const studentName = gate.friend.display_name ?? '（名前未設定）';
    await c.env.DB.prepare(
      `INSERT INTO material_submissions
         (id, friend_id, line_account_id, student_name, note, file_count, status, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 'liff', ?)`,
    )
      .bind(
        submissionId,
        gate.friend.id,
        gate.friend.line_account_id,
        studentName,
        note || null,
        stored.length,
        now,
      )
      .run();

    await c.env.DB.batch(
      stored.map((s) =>
        c.env.DB.prepare(
          `INSERT INTO material_submission_files
             (id, submission_id, seq, r2_key, original_name, content_type, size)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), s.submission_id, s.seq, s.r2_key, s.original_name, s.content_type, s.size),
      ),
    );

    // 手動トリガー運用なので、届いたこと自体を知らせないと取りに行けない。
    await notifyDiscord(
      c.env.DISCORD_WEBHOOK_URL,
      `📥 **教材の提出** — ${studentName}（${stored.length}点）\n${note ? `> ${note}\n` : ''}\`/kyozai-inbox\` で取り込めます`,
    );

    return c.json({ success: true, data: { id: submissionId, fileCount: stored.length } });
  } catch (err) {
    console.error('POST /api/eijaku/submissions error:', err);
    return c.json({ success: false, error: '提出に失敗しました。時間をおいて試してください' }, 500);
  }
});

/** 自分が出したものの控え。直近5件だけ返す（履歴閲覧のためのページではない）。 */
materialSubmissions.get('/api/eijaku/submissions/mine', async (c) => {
  const gate = await requireStudent(c);
  if (!gate.ok) {
    const d = denied(gate.status);
    return c.json(d.body, d.status);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id, note, file_count, status, created_at
       FROM material_submissions
      WHERE friend_id = ?
      ORDER BY created_at DESC
      LIMIT 5`,
  )
    .bind(gate.friend.id)
    .all<Pick<SubmissionRow, 'id' | 'note' | 'file_count' | 'status' | 'created_at'>>();
  return c.json({ success: true, data: results ?? [] });
});

// ── 講師用（API_KEY） ───────────────────────────────────────────────────────

/**
 * 溜まっている提出を見る。既定は pending だけ。
 * ファイルの中身は返さない（メタデータのみ）。実体は下の files エンドポイントで取る。
 */
materialSubmissions.get('/api/material-submissions', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  if (status !== 'all' && !STATUSES.includes(status as Status)) {
    return c.json({ success: false, error: `status は ${STATUSES.join(' / ')} / all のいずれか` }, 400);
  }
  const limit = Math.min(Number(c.req.query('limit') ?? 20) || 20, 100);

  const rows = status === 'all'
    ? await c.env.DB.prepare(
        `SELECT * FROM material_submissions ORDER BY created_at ASC LIMIT ?`,
      ).bind(limit).all<SubmissionRow>()
    : await c.env.DB.prepare(
        `SELECT * FROM material_submissions WHERE status = ? ORDER BY created_at ASC LIMIT ?`,
      ).bind(status, limit).all<SubmissionRow>();

  const subs = rows.results ?? [];
  if (subs.length === 0) return c.json({ success: true, data: [] });

  const placeholders = subs.map(() => '?').join(',');
  const fileRows = await c.env.DB.prepare(
    `SELECT submission_id, seq, r2_key, original_name, content_type, size
       FROM material_submission_files
      WHERE submission_id IN (${placeholders})
      ORDER BY submission_id, seq`,
  )
    .bind(...subs.map((s) => s.id))
    .all<FileRow>();

  const byId = new Map<string, FileRow[]>();
  for (const f of fileRows.results ?? []) {
    const list = byId.get(f.submission_id) ?? [];
    list.push(f);
    byId.set(f.submission_id, list);
  }

  const base = (c.env.TRACKING_BASE_URL ?? new URL(c.req.url).origin).replace(/\/$/, '');
  return c.json({
    success: true,
    data: subs.map((s) => ({
      id: s.id,
      // トークで来たものは note が無い。何のつもりで送ったかはトーク本文にしか無いので、
      // friendId を返しておく（/api/chats/by-friend/:friendId で前後の会話が読める）。
      friendId: s.friend_id,
      studentName: s.student_name,
      note: s.note,
      source: s.source,
      status: s.status,
      createdAt: s.created_at,
      startedAt: s.started_at,
      processedAt: s.processed_at,
      resultNote: s.result_note,
      files: (byId.get(s.id) ?? []).map((f) => ({
        seq: f.seq,
        originalName: f.original_name,
        contentType: f.content_type,
        size: f.size,
        // 取得には API_KEY が要る。素材は生徒の持ち物なので公開URLにはしない。
        url: `${base}/api/material-submissions/${s.id}/files/${f.seq}`,
      })),
    })),
  });
});

/** 素材の実体。R2 からそのまま流す。 */
materialSubmissions.get('/api/material-submissions/:id/files/:seq', async (c) => {
  const id = c.req.param('id');
  const seq = Number(c.req.param('seq'));
  if (!Number.isInteger(seq)) return c.json({ success: false, error: 'seq が不正です' }, 400);

  const row = await c.env.DB.prepare(
    `SELECT r2_key, content_type, original_name FROM material_submission_files
      WHERE submission_id = ? AND seq = ?`,
  )
    .bind(id, seq)
    .first<Pick<FileRow, 'r2_key' | 'content_type' | 'original_name'>>();
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);

  const obj = await c.env.UPLOADS.get(row.r2_key);
  if (!obj) return c.json({ success: false, error: 'Not found' }, 404);

  // docx などは拡張子が付いていないと開けないアプリがある。元のファイル名を返す。
  // 生徒が付けた名前をそのままヘッダに載せないこと（改行や " で壊れる）。
  const safeName = (row.original_name ?? '').replace(/[^\w.\-]+/g, '_').slice(0, 80);

  return new Response(obj.body, {
    headers: {
      'Content-Type': row.content_type,
      'Cache-Control': 'private, max-age=3600',
      ...(safeName ? { 'Content-Disposition': `inline; filename="${safeName}"` } : {}),
    },
  });
});

/**
 * 状態を進める。作り始めたら building、終わったら done。
 * 時刻はサーバーが打つ（ローカルの時計とズレると並べたとき順序が壊れる）。
 */
materialSubmissions.patch('/api/material-submissions/:id', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as {
    status?: string;
    resultNote?: string;
  };
  const status = body.status;
  if (!status || !STATUSES.includes(status as Status)) {
    return c.json({ success: false, error: `status は ${STATUSES.join(' / ')} のいずれか` }, 400);
  }

  const row = await c.env.DB.prepare(
    `SELECT id FROM material_submissions WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: string }>();
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);

  const now = jstNow();
  await c.env.DB.prepare(
    `UPDATE material_submissions
        SET status = ?,
            result_note = COALESCE(?, result_note),
            started_at = CASE WHEN ? = 'building' THEN ? ELSE started_at END,
            processed_at = CASE WHEN ? IN ('done','failed','skipped') THEN ? ELSE processed_at END
      WHERE id = ?`,
  )
    .bind(status, body.resultNote ?? null, status, now, status, now, id)
    .run();

  // 生徒には**何も送らない**。ここは講師の手元の状態を進めるだけ。
  // 「できたよ」を言うのも、棚で公開するのも人間がやる。
  return c.json({ success: true, data: { id, status } });
});
