'use client'

/**
 * 生徒カルテ ── 指導状況の一元管理
 *
 * 単語・古文単語・熟語・4択・文法講座・並び替え・提出素材・授業記録は、それぞれ
 * 自分の画面を持っている。1人を見るのに画面を7枚開くのをやめるための入口。
 *
 * ★ ここに各機能の中身を写さない。出すのは最終実施日と回数まで。
 *   弱点の中身は既存の画面が正本で、詳細からリンクで飛ぶ。写すと片方が必ず古くなる。
 *
 * ★ 既定の並びは「動きの無い順」。
 *   実施済みの上位ではなく**止まっている人**を先に見たい。ランキングは出さない。
 *
 * ★ ブロック・友だち解除の生徒も一覧から消さない。
 *   指導中の生徒が離れたことは、静かに消えるのではなく行に出す。
 *
 * 静的エクスポート構成なので動的ルート（/students/[id]）が使えない。
 * 詳細は同じページ内で切り替える（/bas と同じ）。
 */

import { useEffect, useState, useCallback } from 'react'
import { api, type StudentRow } from '@/lib/api'
import Header from '@/components/layout/header'
import StudentDetailPanel from './student-detail'

/** これ以上動きが無い生徒には日数を出す（色は足さない。数字だけ出せば十分）。 */
const STALE_DAYS = 7

function daysSince(v: string | null): number | null {
  if (!v) return null
  const t = new Date(v.length === 10 ? v + 'T00:00:00+09:00' : v).getTime()
  if (Number.isNaN(t)) return null
  return Math.floor((Date.now() - t) / 86_400_000)
}

function fmtDate(v: string | null): string {
  if (!v) return '—'
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[2]}/${m[3]}` : v
}

/** 目標日まであと何日か。過ぎていたら負の数で返す。 */
function daysUntil(date: string | null): number | null {
  if (!date) return null
  const t = new Date(date + 'T00:00:00+09:00').getTime()
  if (Number.isNaN(t)) return null
  // 「今日」は JST で切る。UTC の日付を使うと、朝9時前だけ1日ずれる
  const jstToday = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
  const today = new Date(jstToday + 'T00:00:00+09:00').getTime()
  return Math.round((t - today) / 86_400_000)
}

type Sort = 'stale' | 'name'

export default function Page() {
  const [students, setStudents] = useState<StudentRow[]>([])
  const [selected, setSelected] = useState<StudentRow | null>(null)
  const [sort, setSort] = useState<Sort>('stale')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // **サイドバーのアカウント切替に連動させない。**
  // 対象はサーバー側の既定（受講生専用OA × 受講生タグ）で固定する。
  // 連動させると、他のOAを見ているあいだ生徒が1人もいない画面になる。
  const load = useCallback(() => {
    setLoading(true)
    api.students
      .list()
      .then((r) => {
        setStudents(r.students ?? [])
        setError('')
      })
      .catch((e) => setError(e instanceof Error ? e.message : '読み込みに失敗しました'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // サーバーが返す順が「動きの無い順」。名前順はここで並べ替える
  const rows =
    sort === 'name'
      ? [...students].sort((a, b) =>
          (a.display_name || '').localeCompare(b.display_name || '', 'ja'),
        )
      : students

  const studied7d = students.filter((s) => s.study_7d > 0).length
  const pending = students.reduce((n, s) => n + s.pending_submissions, 0)

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title="生徒カルテ"
        description="授業・学習・提出・メモを1画面で。動きの無い生徒が上に来ます"
      />

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        {selected ? (
          <StudentDetailPanel
            student={selected}
            onBack={() => {
              setSelected(null)
              load()
            }}
          />
        ) : (
          <>
            {error && (
              <p className="mb-4 text-sm text-red-600 border border-red-200 bg-red-50 rounded-lg px-4 py-3">
                {error}
              </p>
            )}
            {loading && <p className="text-sm text-gray-500">読み込み中...</p>}

            {!loading && (
              <>
                <div className="flex items-center justify-between gap-3 mb-3">
                  <p className="text-xs text-gray-500">
                    受講生 {students.length} 人。直近7日に学習したのは {studied7d} 人。
                    手つかずの提出素材は {pending} 件。
                  </p>
                  <div className="flex gap-1.5 shrink-0">
                    {(
                      [
                        ['stale', '動きの無い順'],
                        ['name', '名前順'],
                      ] as [Sort, string][]
                    ).map(([k, label]) => (
                      <button
                        key={k}
                        onClick={() => setSort(k)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                          sort === k
                            ? 'bg-gray-900 text-white'
                            : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 text-xs text-gray-500">
                        <th className="text-left font-medium px-4 py-2.5">生徒</th>
                        <th className="text-right font-medium px-3 py-2.5 whitespace-nowrap">残り授業</th>
                        <th className="text-right font-medium px-3 py-2.5 whitespace-nowrap">最終授業</th>
                        <th className="text-right font-medium px-3 py-2.5 whitespace-nowrap">7日の学習</th>
                        <th className="text-right font-medium px-3 py-2.5 whitespace-nowrap">最終学習</th>
                        <th className="text-right font-medium px-3 py-2.5 whitespace-nowrap">提出</th>
                        <th className="text-left font-medium px-4 py-2.5">最新のメモ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((s) => {
                        const dStudy = daysSince(s.last_study_at)
                        const dLesson = daysSince(s.last_lesson_date)
                        const stale =
                          (dStudy === null || dStudy >= STALE_DAYS) &&
                          (dLesson === null || dLesson >= STALE_DAYS)
                        const left = daysUntil(s.goal_date)
                        return (
                          <tr
                            key={s.friend_id}
                            onClick={() => setSelected(s)}
                            className={`border-b border-gray-100 last:border-0 cursor-pointer hover:bg-gray-50 ${
                              stale ? 'text-gray-400' : 'text-gray-800'
                            }`}
                          >
                            <td className="px-4 py-2.5">
                              <span className="font-medium">{s.display_name || '（名前なし）'}</span>
                              {s.is_blocked === 1 && (
                                <span className="ml-2 text-[10px] text-red-500 border border-red-200 rounded px-1 py-0.5">
                                  ブロック
                                </span>
                              )}
                              {s.is_following === 0 && (
                                <span className="ml-2 text-[10px] text-gray-500 border border-gray-200 rounded px-1 py-0.5">
                                  友だち解除
                                </span>
                              )}
                              {s.goal_date && (
                                <span className="block text-[11px] text-gray-400">
                                  {s.goal_label}
                                  {left !== null &&
                                    (left >= 0 ? ` まであと${left}日` : ` は${-left}日前に終了`)}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {s.remaining === null ? (
                                <span className="text-xs text-gray-300">契約なし</span>
                              ) : (
                                <span className={s.remaining <= 1 ? 'text-red-600 font-semibold' : ''}>
                                  {s.remaining}回
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-right text-xs whitespace-nowrap">
                              {fmtDate(s.last_lesson_date)}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {s.study_7d || <span className="text-gray-300">0</span>}
                            </td>
                            <td className="px-3 py-2.5 text-right text-xs whitespace-nowrap">
                              {fmtDate(s.last_study_at)}
                              {dStudy !== null && dStudy >= STALE_DAYS && (
                                <span className="block text-[11px] text-gray-400">{dStudy}日前</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {s.pending_submissions ? (
                                <span className="text-amber-600 font-semibold">
                                  {s.pending_submissions}
                                </span>
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 max-w-xs">
                              {s.latest_note ? (
                                <span className="block text-xs text-gray-600 truncate">
                                  {s.latest_note_pinned === 1 && (
                                    <span className="text-amber-500 mr-1">★</span>
                                  )}
                                  {s.latest_note.replace(/\s+/g, ' ')}
                                </span>
                              ) : (
                                <span className="text-xs text-gray-300">メモなし</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {rows.length === 0 && (
                    <p className="text-sm text-gray-500 px-4 py-8 text-center">
                      受講生タグを持つ友だちがいません。
                    </p>
                  )}
                </div>

                <p className="text-xs text-gray-400 mt-3">
                  並ぶのは受講生専用OAで受講生タグを持つ友だちだけです（テストを開ける人と同じ条件。
                  サイドバーのアカウント切替では変わりません）。
                  「7日の学習」は単語・文法・並び替えの実施回数で、解き直しは数えません。
                </p>
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}
