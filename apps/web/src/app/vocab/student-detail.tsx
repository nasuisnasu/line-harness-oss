'use client'

/**
 * 単語テスト — 生徒詳細
 *
 * テスト履歴には**設定を必ず出す**。「70%」だけでは、4択の1〜20番を制限なしで解いた70%なのか、
 * 自己採点の日→英を3秒で解いた70%なのかが分からない。
 */

import { useEffect, useState, useCallback, Fragment } from 'react'
import {
  api,
  type VocabStudentDetail,
  type VocabAnswerRow,
} from '@/lib/api'

function fmtDateTime(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}` : iso
}

const kindLabel = (k: string) => (k === 'review' ? '復習' : k === 'retry' ? 'もう一度' : '通常')
const fmtLabel = (f: string) => (f === 'recall' ? '自己採点' : '4択')
const dirLabel = (d: string) => (d === 'je' ? '日→英' : '英→日')

export default function VocabStudentDetail({
  friendId,
  displayName,
  onBack,
}: {
  friendId: string
  displayName: string | null
  onBack: () => void
}) {
  const [data, setData] = useState<VocabStudentDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openSession, setOpenSession] = useState<number | null>(null)
  const [answers, setAnswers] = useState<Record<number, VocabAnswerRow[]>>({})
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.vocab.student(friendId)
      setData(res)
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [friendId])

  useEffect(() => {
    load()
  }, [load])

  const toggleSession = async (sessionId: number) => {
    if (openSession === sessionId) {
      setOpenSession(null)
      return
    }
    setOpenSession(sessionId)
    if (!answers[sessionId]) {
      try {
        const res = await api.vocab.sessionAnswers(sessionId)
        setAnswers((prev) => ({ ...prev, [sessionId]: res.answers }))
      } catch {
        /* 内訳が出ないだけなので黙って諦める */
      }
    }
  }

  /** 授業前にそのままプリントにできるよう、TSVで書き出す。 */
  const copyWeak = () => {
    if (!data) return
    const tsv = data.weak_words
      .map((w) => [String(w.no).padStart(3, '0'), w.en, w.ja, `${w.wrong}/${w.asked}`].join('\t'))
      .join('\n')
    void navigator.clipboard?.writeText(tsv)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div>
      <button onClick={onBack} className="text-sm text-gray-500 hover:underline">
        ← 生徒一覧
      </button>
      <h2 className="mt-2 text-lg font-bold text-gray-900">{displayName || '(名前なし)'}</h2>

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <p className="py-10 text-center text-sm text-gray-500">読み込み中...</p>
        ) : !data ? null : (
          <>
            {/* 上段：サマリー */}
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <div className="text-xs text-gray-500">実施回数</div>
                <div className="text-2xl font-bold tabular-nums">{data.totals.sessions}</div>
              </div>
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <div className="text-xs text-gray-500">学習日数</div>
                <div className="text-2xl font-bold tabular-nums">{data.totals.days}</div>
              </div>
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <div className="text-xs text-gray-500">解答数</div>
                <div className="text-2xl font-bold tabular-nums">{data.totals.answers}</div>
              </div>
            </div>

            {/* 習得率 */}
            {data.books.filter((b) => b.mastered || b.unmastered).length > 0 && (
              <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4">
                <h2 className="mb-3 text-sm font-semibold text-gray-700">習得率</h2>
                {data.books
                  .filter((b) => b.mastered || b.unmastered)
                  .map((b) => (
                    <div key={b.id} className="mb-3 last:mb-0">
                      <div className="mb-1 flex items-baseline justify-between text-sm">
                        <span className="text-gray-700">{b.name}</span>
                        <span className="tabular-nums text-gray-900">
                          <b>{Math.round(b.rate * 100)}%</b>{' '}
                          <span className="text-xs text-gray-500">
                            {b.mastered}/{b.total}
                          </span>
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                        <div
                          className="h-full bg-emerald-500"
                          style={{ width: `${(b.rate * 100).toFixed(1)}%` }}
                        />
                      </div>
                      <div className="mt-1 text-xs text-gray-500">
                        未習得 {b.unmastered} ／ 未挑戦 {b.untried}
                      </div>
                    </div>
                  ))}
              </div>
            )}

            {/* 中段：テスト履歴（設定つき） */}
            <div className="mt-4 overflow-x-auto rounded-lg border border-gray-200 bg-white">
              <h2 className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-700">
                テスト履歴
              </h2>
              {data.sessions.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-gray-500">まだ実施していません。</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500">
                      <th className="px-4 py-2 font-medium">日時</th>
                      <th className="px-4 py-2 font-medium">単語帳</th>
                      <th className="px-4 py-2 font-medium">範囲</th>
                      <th className="px-4 py-2 font-medium">形式</th>
                      <th className="px-4 py-2 font-medium">方向</th>
                      <th className="px-4 py-2 font-medium">制限</th>
                      <th className="px-4 py-2 font-medium">種別</th>
                      <th className="px-4 py-2 text-right font-medium">結果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sessions.map((s) => (
                      <Fragment key={s.id}>
                        <tr
                          onClick={() => void toggleSession(s.id)}
                          className="cursor-pointer border-b border-gray-100 text-gray-700 last:border-0 hover:bg-gray-50"
                        >
                          <td className="px-4 py-2 tabular-nums">{fmtDateTime(s.finished_at)}</td>
                          <td className="px-4 py-2">{s.book_name}</td>
                          <td className="px-4 py-2 tabular-nums">
                            {s.range_from !== null ? `${s.range_from}–${s.range_to}` : '—'}
                          </td>
                          <td className="px-4 py-2">{fmtLabel(s.format)}</td>
                          <td className="px-4 py-2">{dirLabel(s.direction)}</td>
                          <td className="px-4 py-2 tabular-nums">
                            {s.timer_sec ? `${s.timer_sec}秒` : 'なし'}
                          </td>
                          <td className="px-4 py-2">{kindLabel(s.kind)}</td>
                          <td className="px-4 py-2 text-right font-semibold tabular-nums">
                            {s.correct}/{s.total}
                            <span className="ml-2 text-xs font-normal text-gray-500">
                              {s.total ? Math.round((s.correct / s.total) * 100) : 0}%
                            </span>
                          </td>
                        </tr>
                        {openSession === s.id && (
                          <tr className="border-b border-gray-100 bg-gray-50">
                            <td colSpan={8} className="px-4 py-3">
                              {!answers[s.id] ? (
                                <span className="text-xs text-gray-500">読み込み中...</span>
                              ) : (
                                <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
                                  {answers[s.id].map((a) => (
                                    <span
                                      key={a.word_id}
                                      className={a.ok ? 'text-gray-600' : 'text-red-600'}
                                    >
                                      <span className="tabular-nums text-gray-400">
                                        {String(a.no).padStart(3, '0')}
                                      </span>{' '}
                                      {a.en}
                                      {a.timed_out ? '（時間切れ）' : ''}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* 下段：よく間違える語 */}
            <div className="mt-4 rounded-lg border border-gray-200 bg-white">
              <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
                <h2 className="text-sm font-semibold text-gray-700">
                  よく間違える語
                  <span className="ml-2 text-xs font-normal text-gray-500">
                    出題2回以上・誤答率50%以上
                  </span>
                </h2>
                {data.weak_words.length > 0 && (
                  <button
                    onClick={copyWeak}
                    className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
                  >
                    {copied ? 'コピーしました' : 'TSVでコピー'}
                  </button>
                )}
              </div>
              {data.weak_words.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-gray-500">
                  該当する語がありません。
                </p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {data.weak_words.map((w) => (
                    <li key={w.word_id} className="flex items-baseline gap-3 px-4 py-2 text-sm">
                      <span className="tabular-nums text-xs text-gray-400">
                        {String(w.no).padStart(3, '0')}
                      </span>
                      <span className="font-medium text-gray-900">{w.en}</span>
                      <span className="text-gray-500">{w.ja}</span>
                      <span className="ml-auto tabular-nums text-xs text-red-600">
                        ×{w.wrong}/{w.asked}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
  )
}
