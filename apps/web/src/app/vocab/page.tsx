'use client'

/**
 * 単語テスト — 生徒一覧
 *
 * 知りたいのは「誰が・どれだけ・どんな設定で」の3つだけ。
 * ランキングや「サボっている」の判定は出さない。事実だけを並べる。
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
  return m ? `${m[1]}/${m[2]}/${m[3]}` : iso
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
          <p className="py-10 text-center text-sm text-gray-500">生徒がいません。</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500">
                  <th className="px-4 py-3 font-medium">生徒</th>
                  <th className="px-4 py-3 font-medium">最終実施</th>
                  <th className="px-4 py-3 text-right font-medium">実施回数</th>
                  <th className="px-4 py-3 text-right font-medium">直近正答率</th>
                  <th className="px-4 py-3 text-right font-medium">解答数</th>
                </tr>
              </thead>
              <tbody>
                {students.map((s) => {
                  const d = daysSince(s.last_played_at)
                  const stale = d === null || d >= STALE_DAYS
                  return (
                    <tr
                      key={s.friend_id}
                      className={`border-b border-gray-100 last:border-0 hover:bg-gray-50 ${
                        stale ? 'text-gray-400' : 'text-gray-700'
                      }`}
                    >
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setSelected(s)}
                          className="font-medium text-gray-900 hover:underline"
                        >
                          {s.display_name || '(名前なし)'}
                        </button>
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        {fmtDate(s.last_played_at)}
                        {d !== null && d >= STALE_DAYS && (
                          <span className="ml-2 text-xs">{d}日前</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{s.sessions}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{pct(s.latest_rate)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{s.answers}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-xs text-gray-500">
          未実施の生徒も末尾に出しています。誰が手をつけていないかが分かることのほうが大事なためです。
        </p>
        </>
        )}
      </div>
    </div>
  )
}
