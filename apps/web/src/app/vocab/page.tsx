'use client'

/**
 * 単語テスト — 生徒一覧
 *
 * 知りたいのは「誰が・どれだけ・どんな設定で」の3つだけ。
 * ランキングや「サボっている」の判定は出さない。事実だけを並べる。
 *
 * 一覧は**受講生タグ（VOCAB_ALLOW_TAG_ID）持ちだけ**。絞り込みはサーバー側の既定で、
 * 単語テストを開ける人と完全に一致する。保護者やタグ無しが混ざると「未実施◯人」が
 * 意味を失うため。
 */

import { useEffect, useState, useCallback } from 'react'
import { api, type VocabStudentRow } from '@/lib/api'
import Header from '@/components/layout/header'
import { useAccount } from '@/lib/account-context'
import VocabStudentDetailPanel from './student-detail'

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

export default function VocabPage() {
  const { selectedAccount } = useAccount()
  const [students, setStudents] = useState<VocabStudentRow[]>([])
  // 静的エクスポート構成なので動的ルート（/vocab/[friendId]）が使えない。
  // 詳細は同じページ内で切り替える。
  const [selected, setSelected] = useState<VocabStudentRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!selectedAccount) return
    setLoading(true)
    setError('')
    try {
      // lineAccountId は必ず渡す。渡さないと複数OAの生徒が混ざる。
      const res = await api.vocab.students({ lineAccountId: selectedAccount.id })
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
      <Header title="単語テスト" />
      <div className="p-6">
        {selected ? (
          <VocabStudentDetailPanel
            friendId={selected.friend_id}
            displayName={selected.display_name}
            onBack={() => setSelected(null)}
          />
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
                    {s.book_name && <span className="text-xs text-gray-500">{s.book_name}</span>}
                    <span className={`ml-auto text-xs ${stale ? 'text-gray-400' : 'text-gray-500'}`}>
                      最終実施 {fmtDate(s.last_played_at)}
                      {d !== null && d >= STALE_DAYS && <span className="ml-1">（{d}日前）</span>}
                      {d === null && <span className="ml-1">（未実施）</span>}
                    </span>
                  </div>

                  {s.sessions === 0 ? (
                    <p className="mt-3 text-sm text-gray-400">まだテストを実施していません。</p>
                  ) : (
                    <>
                      <div className="mt-3 flex items-center gap-3">
                        <span className="w-12 flex-none text-right text-lg font-bold tabular-nums text-gray-900">
                          {pct(s.rate)}
                        </span>
                        <span className="flex h-2.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                          <span className="block h-full bg-emerald-500" style={{ width: `${w1.toFixed(1)}%` }} />
                          <span className="block h-full bg-red-400" style={{ width: `${w2.toFixed(1)}%` }} />
                        </span>
                        <span className="w-28 flex-none text-right text-xs tabular-nums text-gray-500">
                          {s.mastered}/{s.total} 語
                        </span>
                      </div>

                      <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-600">
                        <span>
                          復習が必要{' '}
                          <b className={`tabular-nums ${s.unmastered > 0 ? 'text-red-600' : 'text-gray-900'}`}>
                            {s.unmastered}
                          </b>{' '}
                          語
                        </span>
                        <span>
                          未挑戦 <b className="tabular-nums text-gray-900">{s.untried}</b> 語
                        </span>
                        <span>
                          直近の正答率 <b className="tabular-nums text-gray-900">{pct(s.latest_rate)}</b>
                        </span>
                        <span>
                          実施 <b className="tabular-nums text-gray-900">{s.sessions}</b> 回
                        </span>
                        <span>
                          解答 <b className="tabular-nums text-gray-900">{s.answers}</b> 問
                        </span>
                      </div>
                    </>
                  )}

                  <p className="mt-3 text-xs text-blue-600">
                    クリックすると、テスト履歴・何で間違えているか・復習が必要な単語の一覧が開きます →
                  </p>
                </button>
              )
            })}
          </div>
        )}

        <p className="mt-4 text-xs text-gray-500">
          「生徒」タグが付いている友だちだけを出しています（単語テストを開けるのはタグ持ちだけなので、
          この一覧＝使える人の一覧です）。未実施の生徒も末尾に出しています。誰が手をつけていないかが
          分かることのほうが大事なためです。
        </p>
        </>
        )}
      </div>
    </div>
  )
}
