'use client'

/**
 * 並び替えテスト（Build a Sentence）の管理画面
 *
 * 単語・文法テストの兄弟。知りたいのは「誰が・どれだけ・どの型でつまずいているか」。
 * ランキングや「サボっている」の判定は出さない。事実だけを並べる。
 *
 * 一覧は**受講生タグ持ちだけ**（サーバー側の既定）。テストを開ける人と完全に一致する。
 *
 * ★ 他のテストとの違いが2つ。
 *   1. 問題集ではなく**セット**。しかも生徒にはセットを選ばせず、プール全体から出す。
 *      なので「問題」タブでやることは、投入結果の確認と**出題の止め方**だけ
 *   2. つまずきを**分野ではなく型（A1〜G4）**で見る。1問が型を複数持つ
 *
 * 静的エクスポート構成なので動的ルート（/bas/[friendId]）が使えない。
 * 詳細は同じページ内で切り替える。
 */

import { useEffect, useState, useCallback } from 'react'
import { api, type BasStudentRow, type BasSetSummary } from '@/lib/api'
import Header from '@/components/layout/header'
import { useAccount } from '@/lib/account-context'
import BasStudentDetailPanel from './student-detail'

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

type Tab = 'students' | 'sets'

export default function Page() {
  const { selectedAccount } = useAccount()
  const [tab, setTab] = useState<Tab>('students')
  const [students, setStudents] = useState<BasStudentRow[]>([])
  const [sets, setSets] = useState<BasSetSummary[]>([])
  const [selected, setSelected] = useState<BasStudentRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(() => {
    if (!selectedAccount) return
    setLoading(true)
    Promise.all([
      api.bas.students({ lineAccountId: selectedAccount.id }),
      api.bas.sets(selectedAccount.id),
    ])
      .then(([s, k]) => {
        setStudents(s.students ?? [])
        setSets(k.sets ?? [])
        setError('')
      })
      .catch((e) => setError(e instanceof Error ? e.message : '読み込みに失敗しました'))
      .finally(() => setLoading(false))
  }, [selectedAccount])

  useEffect(() => {
    load()
  }, [load])

  // 出題を止めるのは取り返しがつく操作だが、生徒の画面から問題が消えるので確認する
  const toggleSet = async (s: BasSetSummary) => {
    const next = s.active !== 1
    if (!next && !confirm(`${s.name} の出題を止めます。\n生徒の画面からこの${s.count}問が出なくなります。\n（問題は消えません。あとで再開できます）`)) return
    setBusy(s.slug)
    try {
      const res = await api.bas.setActive(s.slug, next, selectedAccount?.id)
      setSets(res.sets ?? [])
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '切り替えに失敗しました')
    } finally {
      setBusy('')
    }
  }

  const activePool = sets.filter((s) => s.active === 1).reduce((n, s) => n + s.count, 0)
  const done = students.filter((s) => s.sessions > 0).length

  return (
    <div className="min-h-screen bg-gray-50">
      <Header title="並び替えテスト" />

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        {selected ? (
          <BasStudentDetailPanel
            student={selected}
            lineAccountId={selectedAccount?.id}
            onBack={() => {
              setSelected(null)
              load()
            }}
          />
        ) : (
          <>
            <div className="flex gap-2 mb-5">
              {(
                [
                  ['students', `生徒 (${students.length})`],
                  ['sets', `問題 (${activePool})`],
                ] as [Tab, string][]
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium ${
                    tab === k
                      ? 'bg-gray-900 text-white'
                      : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {error && (
              <p className="mb-4 text-sm text-red-600 border border-red-200 bg-red-50 rounded-lg px-4 py-3">
                {error}
              </p>
            )}
            {loading && <p className="text-sm text-gray-500">読み込み中...</p>}

            {!loading && tab === 'students' && (
              <>
                <p className="text-xs text-gray-500 mb-3">
                  受講生タグを持つ {students.length} 人のうち、{done} 人が実施済み。
                  いま出題されるのは {activePool} 問です。
                </p>
                <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 text-xs text-gray-500">
                        <th className="text-left font-medium px-4 py-2.5">生徒</th>
                        <th className="text-right font-medium px-3 py-2.5 whitespace-nowrap">実施</th>
                        <th className="text-right font-medium px-3 py-2.5 whitespace-nowrap">解いた問題</th>
                        <th className="text-right font-medium px-3 py-2.5 whitespace-nowrap">正答率</th>
                        <th className="text-left font-medium px-3 py-2.5 whitespace-nowrap">いちばん弱い型</th>
                        <th className="text-right font-medium px-4 py-2.5 whitespace-nowrap">最終</th>
                      </tr>
                    </thead>
                    <tbody>
                      {students.map((s) => {
                        const d = daysSince(s.last_played_at)
                        const stale = s.sessions === 0 || (d !== null && d >= STALE_DAYS)
                        return (
                          <tr
                            key={s.friend_id}
                            onClick={() => setSelected(s)}
                            className={`border-b border-gray-100 last:border-0 cursor-pointer hover:bg-gray-50 ${
                              stale ? 'text-gray-400' : 'text-gray-800'
                            }`}
                          >
                            <td className="px-4 py-2.5 font-medium">
                              {s.display_name || '（名前なし）'}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {s.sessions || '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {s.tried || '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {s.rate === null ? '—' : `${s.rate}%`}
                            </td>
                            <td className="px-3 py-2.5">
                              {s.weakest ? (
                                <span>
                                  <span className="font-mono text-xs text-gray-400 mr-1.5">
                                    {s.weakest.code}
                                  </span>
                                  {s.weakest.name}
                                  <span className="text-xs text-gray-400 ml-1.5 tabular-nums">
                                    {s.weakest.rate}%
                                  </span>
                                </span>
                              ) : (
                                <span className="text-xs text-gray-300">
                                  {s.sessions ? 'まだ判断できません' : '—'}
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-right text-xs whitespace-nowrap">
                              {fmtDate(s.last_played_at)}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {students.length === 0 && (
                    <p className="text-sm text-gray-500 px-4 py-8 text-center">
                      受講生タグを持つ友だちがいません。
                    </p>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-3">
                  「いちばん弱い型」は、その型を3問以上解いた生徒にだけ出します。
                  少ない解答数で決めると当てにならないためです。
                </p>
              </>
            )}

            {!loading && tab === 'sets' && (
              <>
                <p className="text-xs text-gray-500 mb-3">
                  生徒にセットは選ばせません。<strong>有効なセットをまとめた1つのプール</strong>から出題します。
                  問題の投入はローカルの <code className="font-mono">weekly.py</code> から行います。
                </p>
                <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 text-xs text-gray-500">
                        <th className="text-left font-medium px-4 py-2.5">セット</th>
                        <th className="text-right font-medium px-3 py-2.5 whitespace-nowrap">問題数</th>
                        <th className="text-right font-medium px-3 py-2.5 whitespace-nowrap">余分語あり</th>
                        <th className="text-right font-medium px-3 py-2.5 whitespace-nowrap">別解あり</th>
                        <th className="text-right font-medium px-4 py-2.5 whitespace-nowrap">出題</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sets.map((s) => (
                        <tr key={s.id} className="border-b border-gray-100 last:border-0">
                          <td className="px-4 py-2.5">
                            <span className="font-medium text-gray-900">{s.name}</span>
                            <span className="font-mono text-xs text-gray-400 ml-2">{s.slug}</span>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-gray-700">
                            {s.count}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-gray-500">
                            {s.extra_count}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-gray-500">
                            {s.accepted_count}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <button
                              onClick={() => toggleSet(s)}
                              disabled={busy === s.slug}
                              className={`px-3 py-1 rounded-full text-xs font-medium border ${
                                s.active === 1
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                                  : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100'
                              } disabled:opacity-50`}
                            >
                              {busy === s.slug ? '…' : s.active === 1 ? '出題中' : '止めている'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {sets.length === 0 && (
                    <p className="text-sm text-gray-500 px-4 py-8 text-center">
                      セットがありません。
                    </p>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-3">
                  出題を止めても<strong>問題は消えません</strong>。解答履歴が参照しているためです。
                  易しすぎたセットを引っ込めるのはここです。
                </p>
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}
