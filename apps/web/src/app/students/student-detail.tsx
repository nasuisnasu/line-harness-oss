'use client'

/**
 * 生徒カルテ ── 生徒ひとりの中身
 *
 * 上から「いまの見立て（メモ）→ 授業 → 学習 → 提出素材 → 配った教材」の順。
 * **メモを一番上に置く。** テストの数字より先に読みたいのは、前回そこから何を
 * 考えたかのほうだから。数字はその根拠として下に並べる。
 *
 * ★ メモは追記型。上書きしない。
 *   外した見立てが消えると、次の見立てが前と地続きにならない。
 *   「いまの方針」は ★（pinned）で上に固定する。
 *
 * ★ テストは最終実施日と正答率まで。中身は既存の画面が正本なのでリンクで飛ばす。
 *
 * ★ 配った教材は別ワーカー（棚）から取る。取れなくてもカルテの残りは出す。
 */

import { useEffect, useState, useCallback } from 'react'
import {
  api,
  type StudentRow,
  type StudentOverview,
  type StudentTestSummary,
  type FriendNote,
  type ShelfSet,
} from '@/lib/api'

function fmtDate(v: string | null): string {
  if (!v) return '—'
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[2]}/${m[3]}` : v
}

function fmtDateTime(v: string | null): string {
  if (!v) return '—'
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}` : fmtDate(v)
}

function todayJst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
}

/** テストの管理画面。熟語・4択・文法講座は slug でしか見分けられない。 */
function testHref(t: StudentTestSummary): string | null {
  if (t.kind === 'vocab') return t.subject === 'kobun' ? '/kobun' : '/vocab'
  if (t.kind === 'grammar') {
    if (t.slug?.startsWith('idiom-')) return '/idiom'
    if (t.slug === 'grammar-course') return '/course-test'
    return '/grammar'
  }
  if (t.kind === 'bas') return '/bas'
  return null // 品詞分解チェッカーには管理画面がまだ無い
}

const LESSON_LABEL: Record<string, string> = {
  contract: '契約',
  lesson: '実施',
  cancel: 'キャンセル',
}

const SUBMISSION_LABEL: Record<string, string> = {
  pending: '未処理',
  building: '作成中',
  done: '完了',
  failed: '失敗',
  skipped: '教材以外',
}

function Card({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="bg-white border border-gray-200 rounded-lg mb-4">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

export default function StudentDetailPanel({
  student,
  onBack,
}: {
  student: StudentRow
  onBack: () => void
}) {
  const friendId = student.friend_id
  const [data, setData] = useState<StudentOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // メモの入力
  const [noteBody, setNoteBody] = useState('')
  const [notePinned, setNotePinned] = useState(false)
  const [editing, setEditing] = useState<FriendNote | null>(null)
  const [editBody, setEditBody] = useState('')

  // 授業記録の入力
  const [lessonOpen, setLessonOpen] = useState(false)
  const [lessonType, setLessonType] = useState<'contract' | 'lesson' | 'cancel'>('lesson')
  const [lessonCount, setLessonCount] = useState('10')
  const [lessonDate, setLessonDate] = useState(todayJst())
  const [lessonNote, setLessonNote] = useState('')

  // 棚（別ワーカー）
  const [shelf, setShelf] = useState<{ linked: boolean; sets: ShelfSet[] } | null>(null)
  const [shelfError, setShelfError] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    api.students
      .get(friendId)
      .then((r) => {
        setData(r)
        setError('')
      })
      .catch((e) => setError(e instanceof Error ? e.message : '読み込みに失敗しました'))
      .finally(() => setLoading(false))
  }, [friendId])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    api.students
      .materials(friendId)
      .then((r) => setShelf({ linked: r.linked, sets: r.sets ?? [] }))
      .catch(() => setShelfError('棚から取得できませんでした'))
  }, [friendId])

  const addNote = async () => {
    const body = noteBody.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      await api.students.addNote(friendId, body, notePinned)
      setNoteBody('')
      setNotePinned(false)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'メモを保存できませんでした')
    } finally {
      setBusy(false)
    }
  }

  const saveEdit = async () => {
    if (!editing || busy) return
    const body = editBody.trim()
    if (!body) return
    setBusy(true)
    try {
      await api.students.updateNote(friendId, editing.id, { body })
      setEditing(null)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'メモを更新できませんでした')
    } finally {
      setBusy(false)
    }
  }

  const togglePin = async (n: FriendNote) => {
    setBusy(true)
    try {
      await api.students.updateNote(friendId, n.id, { pinned: n.pinned !== 1 })
      load()
    } finally {
      setBusy(false)
    }
  }

  const removeNote = async (n: FriendNote) => {
    if (!confirm('このメモを削除します。元に戻せません。')) return
    setBusy(true)
    try {
      await api.students.deleteNote(friendId, n.id)
      load()
    } finally {
      setBusy(false)
    }
  }

  const addLesson = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api.friends.lessons.add(friendId, {
        type: lessonType,
        count: lessonType === 'contract' ? Number(lessonCount) || 1 : 1,
        recordDate: lessonDate,
        note: lessonNote.trim() || undefined,
      })
      setLessonNote('')
      setLessonOpen(false)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '授業記録を保存できませんでした')
    } finally {
      setBusy(false)
    }
  }

  const removeLesson = async (id: string) => {
    if (!confirm('この記録を削除します。残り回数が変わります。')) return
    setBusy(true)
    try {
      await api.friends.lessons.delete(friendId, id)
      load()
    } finally {
      setBusy(false)
    }
  }

  const name = data?.friend?.display_name || student.display_name || '（名前なし）'

  return (
    <div>
      <button
        onClick={onBack}
        className="mb-4 text-sm text-gray-500 hover:text-gray-900 flex items-center gap-1"
      >
        ← 一覧に戻る
      </button>

      {error && (
        <p className="mb-4 text-sm text-red-600 border border-red-200 bg-red-50 rounded-lg px-4 py-3">
          {error}
        </p>
      )}
      {loading && !data && <p className="text-sm text-gray-500">読み込み中...</p>}

      {data && (
        <>
          {/* ヘッダ */}
          <section className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            <div className="flex items-start gap-3">
              {data.friend?.picture_url ? (
                <img
                  src={data.friend.picture_url}
                  alt=""
                  className="w-12 h-12 rounded-full object-cover shrink-0"
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-gray-100 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-lg font-bold text-gray-900">{name}</h1>
                  {data.friend?.is_blocked === 1 && (
                    <span className="text-[10px] text-red-500 border border-red-200 rounded px-1 py-0.5">
                      ブロック
                    </span>
                  )}
                  {data.friend?.is_following === 0 && (
                    <span className="text-[10px] text-gray-500 border border-gray-200 rounded px-1 py-0.5">
                      友だち解除
                    </span>
                  )}
                </div>
                <div className="mt-1.5 flex gap-1.5 flex-wrap">
                  {data.tags.map((t) => (
                    <span
                      key={t.id}
                      className="text-[11px] rounded px-1.5 py-0.5 text-white"
                      style={{ backgroundColor: t.color || '#9CA3AF' }}
                    >
                      {t.name}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  {data.goal
                    ? `${data.goal.label}：${data.goal.target_date}`
                    : '目標日は未設定（生徒がテスト画面で設定します）'}
                  <span className="mx-2 text-gray-300">|</span>
                  最後のやり取り {fmtDateTime(data.last_message_at)}
                </p>
              </div>
              <a
                href={`/chats?friendId=${friendId}`}
                className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
              >
                個別チャット
              </a>
            </div>
          </section>

          {/* メモ（いまの見立て） */}
          <Card title={`講師メモ（${data.notes.length}）`}>
            <div className="p-4 border-b border-gray-100">
              <textarea
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
                rows={3}
                placeholder="今どうなっているか／次に何をするか。生徒には出ません。"
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-gray-400"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <label className="text-xs text-gray-500 flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={notePinned}
                    onChange={(e) => setNotePinned(e.target.checked)}
                  />
                  いまの方針として上に固定する
                </label>
                <button
                  onClick={addNote}
                  disabled={busy || !noteBody.trim()}
                  className="text-sm px-4 py-1.5 rounded-lg bg-gray-900 text-white disabled:opacity-40"
                >
                  メモを追加
                </button>
              </div>
            </div>

            {data.notes.length === 0 ? (
              <p className="text-sm text-gray-400 px-4 py-6 text-center">まだメモがありません。</p>
            ) : (
              <ul>
                {data.notes.map((n) => (
                  <li key={n.id} className="px-4 py-3 border-b border-gray-100 last:border-0">
                    {editing?.id === n.id ? (
                      <>
                        <textarea
                          value={editBody}
                          onChange={(e) => setEditBody(e.target.value)}
                          rows={4}
                          className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2"
                        />
                        <div className="mt-2 flex gap-2 justify-end">
                          <button
                            onClick={() => setEditing(null)}
                            className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600"
                          >
                            やめる
                          </button>
                          <button
                            onClick={saveEdit}
                            disabled={busy}
                            className="text-xs px-3 py-1.5 rounded-lg bg-gray-900 text-white disabled:opacity-40"
                          >
                            保存
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex items-start gap-2">
                          <button
                            onClick={() => togglePin(n)}
                            title={n.pinned === 1 ? '固定を外す' : 'いまの方針として固定する'}
                            className={`shrink-0 text-sm ${
                              n.pinned === 1 ? 'text-amber-500' : 'text-gray-300 hover:text-gray-400'
                            }`}
                          >
                            ★
                          </button>
                          <p className="flex-1 text-sm text-gray-800 whitespace-pre-wrap break-words">
                            {n.body}
                          </p>
                        </div>
                        <div className="mt-1.5 pl-6 flex items-center gap-3 text-[11px] text-gray-400">
                          <span>{fmtDateTime(n.created_at)}</span>
                          {n.updated_at !== n.created_at && <span>（編集済み）</span>}
                          <button
                            onClick={() => {
                              setEditing(n)
                              setEditBody(n.body)
                            }}
                            className="hover:text-gray-700"
                          >
                            編集
                          </button>
                          <button onClick={() => removeNote(n)} className="hover:text-red-600">
                            削除
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* 授業 */}
          <Card
            title="授業"
            action={
              <button
                onClick={() => setLessonOpen((v) => !v)}
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
              >
                {lessonOpen ? '閉じる' : '記録を追加'}
              </button>
            }
          >
            <div className="px-4 py-3 flex gap-6 text-sm border-b border-gray-100">
              <span>
                <span className="text-xs text-gray-500 mr-1.5">残り</span>
                {data.lessons.summary.remaining === null ? (
                  <span className="text-gray-400 text-xs">契約なし</span>
                ) : (
                  <strong
                    className={
                      data.lessons.summary.remaining <= 1 ? 'text-red-600' : 'text-gray-900'
                    }
                  >
                    {data.lessons.summary.remaining}回
                  </strong>
                )}
              </span>
              <span className="text-gray-600">
                <span className="text-xs text-gray-500 mr-1.5">契約</span>
                {data.lessons.summary.contracted}
              </span>
              <span className="text-gray-600">
                <span className="text-xs text-gray-500 mr-1.5">実施</span>
                {data.lessons.summary.conducted}
              </span>
              <span className="text-gray-600">
                <span className="text-xs text-gray-500 mr-1.5">キャンセル</span>
                {data.lessons.summary.cancelled}
              </span>
            </div>

            {lessonOpen && (
              <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex flex-wrap gap-2 items-center">
                <select
                  value={lessonType}
                  onChange={(e) => setLessonType(e.target.value as typeof lessonType)}
                  className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
                >
                  <option value="lesson">実施</option>
                  <option value="cancel">キャンセル</option>
                  <option value="contract">契約</option>
                </select>
                {lessonType === 'contract' && (
                  <input
                    type="number"
                    min={1}
                    value={lessonCount}
                    onChange={(e) => setLessonCount(e.target.value)}
                    className="w-20 text-sm border border-gray-200 rounded-lg px-2 py-1.5"
                  />
                )}
                <input
                  type="date"
                  value={lessonDate}
                  onChange={(e) => setLessonDate(e.target.value)}
                  className="text-sm border border-gray-200 rounded-lg px-2 py-1.5"
                />
                <input
                  value={lessonNote}
                  onChange={(e) => setLessonNote(e.target.value)}
                  placeholder="メモ（任意）"
                  className="flex-1 min-w-40 text-sm border border-gray-200 rounded-lg px-2 py-1.5"
                />
                <button
                  onClick={addLesson}
                  disabled={busy}
                  className="text-sm px-4 py-1.5 rounded-lg bg-gray-900 text-white disabled:opacity-40"
                >
                  追加
                </button>
              </div>
            )}

            {data.lessons.records.length === 0 ? (
              <p className="text-sm text-gray-400 px-4 py-6 text-center">記録がありません。</p>
            ) : (
              <ul className="max-h-64 overflow-y-auto">
                {data.lessons.records.map((r) => (
                  <li
                    key={r.id}
                    className="px-4 py-2 border-b border-gray-100 last:border-0 flex items-center gap-3 text-sm"
                  >
                    <span className="w-16 text-xs text-gray-500 tabular-nums">
                      {fmtDate(r.record_date)}
                    </span>
                    <span
                      className={`w-24 text-xs ${
                        r.type === 'contract'
                          ? 'text-emerald-600'
                          : r.type === 'cancel'
                            ? 'text-amber-600'
                            : 'text-gray-700'
                      }`}
                    >
                      {LESSON_LABEL[r.type] ?? r.type}
                      {r.type === 'contract' ? ` +${r.count}` : ''}
                    </span>
                    <span className="flex-1 text-xs text-gray-500 truncate">{r.note || ''}</span>
                    <button
                      onClick={() => removeLesson(r.id)}
                      className="text-[11px] text-gray-300 hover:text-red-600"
                    >
                      削除
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* 学習 */}
          <Card title="学習">
            {data.tests.length === 0 ? (
              <p className="text-sm text-gray-400 px-4 py-6 text-center">
                まだどのテストも実施していません。
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-xs text-gray-500">
                    <th className="text-left font-medium px-4 py-2">テスト</th>
                    <th className="text-right font-medium px-3 py-2">実施</th>
                    <th className="text-right font-medium px-3 py-2">解答</th>
                    <th className="text-right font-medium px-3 py-2">正答率</th>
                    <th className="text-right font-medium px-4 py-2">最終</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tests.map((t) => {
                    const href = testHref(t)
                    return (
                      <tr key={`${t.kind}:${t.slug ?? t.name}`} className="border-b border-gray-100 last:border-0">
                        <td className="px-4 py-2">
                          {href ? (
                            <a href={href} className="text-gray-800 hover:underline">
                              {t.name}
                            </a>
                          ) : (
                            <span className="text-gray-800">{t.name}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                          {t.sessions}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                          {t.answers || '—'}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {t.rate === null ? (
                            <span className="text-gray-300">—</span>
                          ) : (
                            <span className={t.rate < 60 ? 'text-red-600 font-semibold' : 'text-gray-700'}>
                              {t.rate}%
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right text-xs text-gray-500 whitespace-nowrap">
                          {fmtDate(t.last_at)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            <p className="text-[11px] text-gray-400 px-4 py-2 border-t border-gray-100">
              正答率は延べ解答の累計です。いま何が弱いかは各テストの画面で見てください
              （解き直しは数えていません）。
            </p>
          </Card>

          {/* 提出素材 */}
          <Card title={`提出素材（${data.submissions.length}）`}>
            {data.submissions.length === 0 ? (
              <p className="text-sm text-gray-400 px-4 py-6 text-center">提出はまだありません。</p>
            ) : (
              <ul>
                {data.submissions.map((s) => (
                  <li
                    key={s.id}
                    className="px-4 py-2 border-b border-gray-100 last:border-0 flex items-center gap-3 text-sm"
                  >
                    <span className="w-20 text-xs text-gray-500 tabular-nums">
                      {fmtDate(s.created_at)}
                    </span>
                    <span
                      className={`w-20 text-xs ${
                        s.status === 'pending' || s.status === 'building'
                          ? 'text-amber-600'
                          : s.status === 'failed'
                            ? 'text-red-600'
                            : 'text-gray-500'
                      }`}
                    >
                      {SUBMISSION_LABEL[s.status] ?? s.status}
                    </span>
                    <span className="w-12 text-xs text-gray-400">{s.file_count}点</span>
                    <span className="flex-1 text-xs text-gray-600 truncate">
                      {s.note || s.result_note || ''}
                    </span>
                    <span className="text-[11px] text-gray-300">
                      {s.source === 'liff' ? 'フォーム' : 'トーク'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* 配った教材（棚） */}
          <Card title="配った教材">
            {shelfError ? (
              <p className="text-sm text-gray-400 px-4 py-6 text-center">{shelfError}</p>
            ) : !shelf ? (
              <p className="text-sm text-gray-400 px-4 py-6 text-center">読み込み中...</p>
            ) : !shelf.linked ? (
              <p className="text-sm text-gray-400 px-4 py-6 text-center">
                棚にこの生徒が登録されていません。
              </p>
            ) : shelf.sets.length === 0 ? (
              <p className="text-sm text-gray-400 px-4 py-6 text-center">
                公開済みの教材がありません。
              </p>
            ) : (
              <ul>
                {shelf.sets.map((set, i) => (
                  <li key={i} className="px-4 py-3 border-b border-gray-100 last:border-0">
                    <p className="text-sm font-medium text-gray-800">{set.name}</p>
                    <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                      {set.files.map((f, j) => (
                        <li key={j}>
                          <a
                            href={f.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-gray-500 hover:text-gray-900 hover:underline"
                          >
                            {f.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
