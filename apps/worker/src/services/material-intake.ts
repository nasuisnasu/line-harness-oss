/**
 * 教材素材の受け取り（トーク経由）
 *
 * 生徒はフォームを開かない。**普通のトークに写真やWordを投げる。**
 * その実体を LINE から取ってきて R2 に置き、material_submissions に積む。
 *
 *   生徒がトークに送信 ──▶ webhook ──▶ ここ ──▶ R2 + material_submissions(pending)
 *                                                  │
 *                                        /kyozai-inbox が取りに来る
 *
 * webhook は「画像が来た」までしか知らない。実体は
 * api-data.line.me（api.line.me ではない）から messageId で取りに行く必要がある。
 *
 * 教材とは限らない写真も混ざる。**ここでは選別しない。**
 * 何が教材かは、取り込むときに人間（と Claude）が決める。
 * サーバーが勝手に捨てると、捨てられたことに誰も気づけない。
 */

import { jstNow, toJstString } from '@line-crm/db';
import { notifyDiscord } from './discord-notify.js';

/**
 * 受け取れる形。生徒が実際に送ってくるのは、スクショ・スマホの写真・PDF・Word。
 * 塾のプリントを Word でもらってそのまま転送、という経路が実在するので docx は必須。
 */
export const ALLOWED_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'text/plain': 'txt',
  'text/markdown': 'md',
};

/**
 * MIME が当てにならないときの逃げ道。
 * LINE の file メッセージは content-type が application/octet-stream で返ることがあり、
 * Android のファイル選択も docx を空 MIME で寄こす。MIME だけで弾くと、
 * その生徒だけ永久に出せなくなる。
 */
export const ALLOWED_EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  txt: 'text/plain',
  md: 'text/markdown',
};

/** 保存に使う拡張子と、正規化した MIME を返す。受け取れない形なら null。 */
export function resolveUploadType(
  fileName: string | undefined,
  mime: string | undefined,
): { ext: string; contentType: string } | null {
  const cleanMime = (mime ?? '').split(';')[0].trim().toLowerCase();
  const byMime = ALLOWED_MIME[cleanMime];
  if (byMime) return { ext: byMime, contentType: cleanMime };

  const ext = (fileName ?? '').split('.').pop()?.toLowerCase() ?? '';
  const byExt = ALLOWED_EXT_TO_MIME[ext];
  if (byExt) return { ext, contentType: byExt };

  return null;
}

/**
 * 1ファイルの上限。
 *
 * 20MB だったころ、あみさんが iPad で手書きした精読ワーク（27ページ・**75MB**）が
 * ここで落ちた。本人は「送れた」と思っていて、こちらには何も残らなかった（2026-08-22）。
 * 手書きのPDFは1ページ数MBになるので、20MB では足りない。
 *
 * 大きいものは arrayBuffer に載せると Worker のメモリを踏むので、
 * content-length が分かるときは R2 へ**素通し**する（下の ingest 参照）。
 */
const MAX_BYTES = 100 * 1024 * 1024;

/** 素通しにできないとき（長さが分からないとき）だけ使う、メモリに載せる上限。 */
const MAX_BUFFERED_BYTES = 20 * 1024 * 1024;

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;

/**
 * まとめる時間の窓（分）。
 * 2ページの長文を写真2枚で送ると、LINE からは別々のイベントで届く。
 * 素直に作ると1枚＝1提出になって、教材が2本に割れる。
 * 直前の提出がこの窓の中にあれば、そこに足す。
 */
const GROUP_WINDOW_MIN = 15;

interface IngestArgs {
  db: D1Database;
  uploads: R2Bucket;
  accessToken: string;
  friend: { id: string; display_name: string | null; line_account_id: string | null };
  messageId: string;
  /** file メッセージのときだけ来る。image には無い。 */
  fileName?: string;
  discordWebhookUrl?: string;
}

/**
 * トークに来た添付を1つ取り込む。
 *
 * 失敗しても投げない。ここで例外を上げると webhook のイベント処理ごと落ちて、
 * 同じリクエストに乗っている他のイベント（タグ付けやシナリオ）まで巻き添えになる。
 */
export async function ingestTalkAttachment(args: IngestArgs): Promise<void> {
  const { db, uploads, accessToken, friend, messageId, fileName, discordWebhookUrl } = args;

  const who = friend.display_name ?? '（名前未設定）';
  /**
   * 取り込めなかったことを必ず鳴らす。
   *
   * 以前はここを console.log で黙って見送っていた。生徒は送ったつもり、
   * こちらは届いたことすら知らない、という状態が実際に起きた（75MBのPDF）。
   * **落としたことは、落とした側が言う。**生徒には何も送らない（オーナーが手で拾う）。
   */
  const dropped = async (why: string, extra?: string) => {
    console.log(`[material-intake] 見送り messageId=${messageId} ${why} ${extra ?? ''}`);
    await notifyDiscord(
      discordWebhookUrl,
      [
        `⚠️ **提出を取り込めませんでした**`,
        `👤 ${who}`,
        `📄 ${fileName ?? '（ファイル名なし）'}`,
        `理由: ${why}${extra ? `（${extra}）` : ''}`,
        `本人は送ったつもりです。LINEのトークから手で拾ってください`,
      ].join('\n'),
    );
  };

  try {
    // 実体は api-data.line.me にある。api.line.me だと 404 になる。
    const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      console.error(`[material-intake] コンテンツ取得に失敗 messageId=${messageId} status=${res.status}`);
      await dropped('LINEから中身を取れなかった', `status=${res.status}`);
      return;
    }

    const type = resolveUploadType(fileName, res.headers.get('content-type') ?? undefined);
    if (!type) {
      // 教材にならない形（zip など）
      await dropped('受け取れない形式', res.headers.get('content-type') ?? 'content-type なし');
      return;
    }

    // 長さが分かるものは R2 へ素通しする。arrayBuffer に載せると
    // 大きいPDFで Worker のメモリを踏む。
    const declared = Number(res.headers.get('content-length') || 0);
    let body: ArrayBuffer | ReadableStream;
    let size: number;
    if (declared > 0) {
      if (declared > MAX_BYTES) {
        await dropped('大きすぎる', `${mb(declared)} / 上限 ${mb(MAX_BYTES)}`);
        return;
      }
      if (!res.body) {
        await dropped('中身が空だった');
        return;
      }
      body = res.body;
      size = declared;
    } else {
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > MAX_BUFFERED_BYTES) {
        await dropped('大きすぎる', `${mb(buffer.byteLength)} / 長さ不明のときの上限 ${mb(MAX_BUFFERED_BYTES)}`);
        return;
      }
      body = buffer;
      size = buffer.byteLength;
    }

    // 直前の提出に相乗りできるか見る。
    // created_at はこのプロジェクト共通の JST 文字列なので、比較する側も同じ形で作る。
    const jstWindowStart = toJstString(new Date(Date.now() - GROUP_WINDOW_MIN * 60 * 1000));

    const open = await db
      .prepare(
        `SELECT id, file_count FROM material_submissions
          WHERE friend_id = ? AND source = 'talk' AND status = 'pending'
            AND created_at >= ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(friend.id, jstWindowStart)
      .first<{ id: string; file_count: number }>();

    const studentName = who;

    let submissionId: string;
    let isNew = false;

    if (open) {
      submissionId = open.id;
    } else {
      submissionId = crypto.randomUUID();
      isNew = true;
      await db
        .prepare(
          `INSERT INTO material_submissions
             (id, friend_id, line_account_id, student_name, note, file_count, status, source, created_at)
           VALUES (?, ?, ?, ?, NULL, 0, 'pending', 'talk', ?)`,
        )
        .bind(submissionId, friend.id, friend.line_account_id, studentName, jstNow())
        .run();
    }

    // キーに messageId を使う。**seq を使ってはいけない。**
    // seq は file_count を読んでから書くまでに競合する。写真を続けて送ると
    // 同じ番号が2回払い出され、同じキーに上書きして1枚消える（実際に消した）。
    // messageId は LINE 側で一意なので、競合しても衝突しない。
    const key = `submissions/${submissionId}/${messageId}.${type.ext}`;
    await uploads.put(key, body, { httpMetadata: { contentType: type.contentType } });

    // seq も JS 側で決めない。SQL の中で MAX+1 を取れば、読んでから書くまでの
    // すき間が無くなる。表示順の目安にしかならない値だが、欠番や重複があると
    // 「1枚足りないのでは」と毎回疑うことになる。
    await db
      .prepare(
        `INSERT INTO material_submission_files
           (id, submission_id, seq, r2_key, original_name, content_type, size)
         VALUES (
           ?, ?,
           (SELECT COALESCE(MAX(seq), -1) + 1 FROM material_submission_files WHERE submission_id = ?),
           ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        submissionId,
        submissionId,
        key,
        fileName ?? null,
        type.contentType,
        size,
      )
      .run();

    await db
      .prepare(`UPDATE material_submissions SET file_count = file_count + 1 WHERE id = ?`)
      .bind(submissionId)
      .run();

    // ここでは**通知しない**。1時間おきの自動取り込みが拾って、
    // 教材になったものだけ「できました」と鳴る。
    // 届いた時点で鳴らすと、雑談の写真でも鳴ってしまうし、
    // 同じ1本の長文について「届いた」「できた」で2回鳴ることになる。
    if (isNew) {
      console.log(`[material-intake] 新規受け取り ${submissionId} (${studentName})`);
    }
  } catch (err) {
    console.error('[material-intake] 取り込みに失敗:', err);
    await dropped('取り込みの途中で失敗した', String(err).slice(0, 200));
  }
}
