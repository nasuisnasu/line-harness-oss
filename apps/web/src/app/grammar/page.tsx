'use client'

/**
 * 文法テスト — 生徒一覧 ／ 問題集
 *
 * 単語テスト（`/vocab`）の兄弟。知りたいのは「誰が・どれだけ・どこでつまずいているか」。
 * ランキングや「サボっている」の判定は出さない。事実だけを並べる。
 *
 * 一覧は**受講生タグ（VOCAB_ALLOW_TAG_ID）持ちだけ**。絞り込みはサーバー側の既定で、
 * 文法テストを開ける人と完全に一致する。
 *
 * 単語テストとの違いは「いちばん弱い分野」を一覧の時点で出すこと。
 * 声をかける入口がそこにしかないため。
 */

import { useEffect, useState, useCallback } from 'react'
import { api, type GrammarStudentRow } from '@/lib/api'
import Header from '@/components/layout/header'
import { useAccount } from '@/lib/account-context'
import GrammarStudentDetailPanel from './student-detail'
import GrammarBooksPanel from './books'

/** これ以上実施がない生徒は行を薄くする（色は足さない）。 */
const STALE_DAYS = 7

function daysSince(iso: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.floor((Date.now() - t) / 86_400_000)
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[2]}/${m[3]}` : iso
}

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`
}

type Tab = 'students' | 'books'

export default function GrammarPage() {
  const { selectedAccount } = useAccount()
  const [tab, setTab] = useState<Tab>('students')
  const [students, setStudents] = useState<GrammarStudentRow[]>([])
  // 静的エクスポート構成なので動的ルート（/grammar/[friendId]）が使えない。
  // 詳細は同じページ内で切り替える。
  const [selected, setSelected] = useState<GrammarStudentRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!selectedAccount) return
    setLoading(true)
    setError('')
    try {
      // lineAccountId は必ず渡す。渡さないと複数OAの生徒が混ざる。
      const res = await api.grammar.students({ lineAccountId: selectedAccount.id })
      setStudents(res.students ?? [])
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccount])

  useEffect(() => {
    load()
  }, [load])

  const played = students.filter((s) => s.sessions > 0).length

  return (
    <div className="flex-1 overflow-auto">
      <Header title="文法テスト" />
      <div className="p-6">
        {selected ? (
          <GrammarStudentDetailPanel
            friendId={selected.friend_id}
            displayName={selected.display_name}
            onBack={() => setSelected(null)}
          />
        ) : (
          <>
            <div className="mb-5 flex gap-2 border-b border-gray-200">
              {(
                [
                  ['students', '生徒'],
                  ['books', '問題集'],
                ] as [Tab, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
                    tab === key
                      ? 'border-gray-900 text-gray-900'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === 'books' ? (
              <GrammarBooksPanel />
            ) : (
              <>
                {error && (
                  <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {error}
                  </div>
                )}

                <div className="mb-4 flex flex-wrap gap-4 text-sm text-gray-600">
                  <span>
                    生徒 <b className="text-gray-900">{students.length}</b> 人
                  </span>
                  <span>
                    実施あり <b className="text-gray-900">{played}</b> 人
                  </span>
                  <span>
                    未実施 <b className="text-gray-900">{students.length - played}</b> 人
                  </span>
                </div>

                {loading ? (
                  <p className="py-10 text-center text-sm text-gray-500">読み込み中...</p>
                ) : students.length === 0 ? (
                  <p className="py-10 text-center text-sm text-gray-500">
                    「生徒」タグが付いた友だちがいません。
                  </p>
                ) : (
                  <div className="space-y-3">
                    {students.map((s) => {
                      const d = daysSince(s.last_played_at)
                      const stale = d === null || d >= STALE_DAYS
                      const w1 = s.total ? (s.mastered / s.total) * 100 : 0
                      const w2 = s.total ? (s.unmastered / s.total) * 100 : 0
                      return (
                        <button
                          key={s.friend_id}
                          onClick={() => setSelected(s)}
                          className="block w-full rounded-lg border border-gray-200 bg-white p-4 text-left transition hover:border-gray-300 hover:shadow-sm"
                        >
                          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                            <span className="text-base font-semibold text-gray-900">
                              {s.display_name || '(名前なし)'}
                            </span>
                            {s.book_name && (
                              <span className="text-xs text-gray-500">{s.book_name}</span>
                            )}
                            <span
                              className={`ml-auto text-xs ${stale ? 'text-gray-400' : 'text-gray-500'}`}
                            >
                              最終実施 {fmtDate(s.last_played_at)}
                              {d !== null && d >= STALE_DAYS && (
                                <span className="ml-1">（{d}日前）</span>
                              )}
                              {d === null && <span className="ml-1">（未実施）</span>}
                            </span>
                          </div>

                          {s.sessions === 0 ? (
                            <p className="mt-3 text-sm text-gray-400">
                              まだテストを実施していません。
                            </p>
                          ) : (
                            <>
                              {/* 総復習テスト＝忘れの検出。実力ではないので「実力」と書かない */}
                              <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                                <span className="text-xs text-gray-500">総復習テスト</span>
                                {s.checkup_score === null ? (
                                  <span className="text-sm text-gray-400">未受験</span>
                                ) : (
                                  <>
                                    <b className="text-2xl tabular-nums text-gray-900">
                                      {pct(s.checkup_score)}
                                    </b>
                                    <span className="text-xs text-gray-500">
                                      直近{s.checkup_sessions}回の加重平均（忘れの検出）
                                    </span>
                                  </>
                                )}
                                {/* 声をかける入口。分野ではなく単元で出す（そのまま授業で扱える粒度） */}
                                {s.weakest_unit && (
                                  <span className="ml-auto rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                                    いちばん弱い単元 <b>{s.weakest_unit.name}</b>{' '}
                                    {pct(s.weakest_unit.rate)}
                                    <span className="ml-1 text-amber-600">
                                      ({s.weakest_unit.category}・延べ{s.weakest_unit.asked}回)
                                    </span>
                                  </span>
                                )}
                              </div>

                              <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-gray-100">
                                <span
                                  className="block h-full bg-emerald-500"
                                  style={{ width: `${w1.toFixed(1)}%` }}
                                />
                                <span
                                  className="block h-full bg-red-400"
                                  style={{ width: `${w2.toFixed(1)}%` }}
                                />
                              </div>
                              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-600">
                                <span>
                                  学習済み{' '}
                                  <b className="tabular-nums text-gray-900">
                                    {s.mastered + s.unmastered}
                                  </b>
                                  {' / '}
                                  <span className="tabular-nums">{s.total}</span> 問
                                </span>
                                <span>
                                  復習が必要{' '}
                                  <b
                                    className={`tabular-nums ${
                                      s.unmastered > 0 ? 'text-red-600' : 'text-gray-900'
                                    }`}
                                  >
                                    {s.unmastered}
                                  </b>
                                </span>
                                <span>
                                  直近の分野テスト{' '}
                                  <b className="tabular-nums text-gray-900">{pct(s.latest_rate)}</b>
                                </span>
                                <span>
                                  実施 <b className="tabular-nums text-gray-900">{s.sessions}</b> 回
                                </span>
                              </div>
                            </>
                          )}

                          <p className="mt-3 text-xs text-blue-600">
                            クリックすると、よく間違えている単元・どの誤答を選んだか・総復習テストの推移が開きます
                            →
                          </p>
                        </button>
                      )
                    })}
                  </div>
                )}

                <p className="mt-4 text-xs text-gray-500">
                  「生徒」タグが付いている友だちだけを出しています（文法テストを開けるのはタグ持ちだけなので、
                  この一覧＝使える人の一覧です）。未実施の生徒も末尾に出しています。誰が手をつけていないかが
                  分かることのほうが大事なためです。
                </p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
