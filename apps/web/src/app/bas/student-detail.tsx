'use client'

/**
 * 並び替えテスト ── 生徒ひとりの中身
 *
 * 知りたいのは「どの型で落としているか」。それだけ。
 * 単語・文法テストの詳細と違い、**分野ではなく型（A1〜G4）で見る。**
 * 1問が型を複数持つので、合計は問題数と一致しない（画面にもそう書く）。
 *
 * 大分類（A〜G）→ 型 の2階層。38個をいきなり並べても読めないため。
 * 未挑戦の型は「—」と出す。**0% と書かない**——解いていないのに
 * 全問落としたように見えるのが一番まずい。
 */

import { useEffect, useState } from 'react'
import { api, type BasStudentRow, type BasStudentDetail, type BasGroupStat } from '@/lib/api'

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}` : iso
}

function kindLabel(kind: string, focus: string | null): string {
  if (kind === 'retry') return '解き直し'
  if (kind === 'weak') return '弱点復習'
  if (kind === 'type') return focus ? `${focus} 集中` : '記号指定'
  return '総合ランダム'
}

/** 低いほど濃く出す。色は1色だけ使う（赤と緑を混ぜると読む側が疲れる）。 */
function rateClass(rate: number, tried: number): string {
  if (!tried) return 'text-gray-300'
  if (rate < 50) return 'text-red-600 font-semibold'
  if (rate < 80) return 'text-amber-600 font-medium'
  return 'text-gray-700'
}

function GroupRow({ g }: { g: BasGroupStat }) {
  const [open, setOpen] = useState(false)
  const w = g.tried ? (g.ok / g.tried) * 100 : 0
  return (
    <div className="border-b border-gray-100 last:border-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 text-left"
      >
        <span className="w-5 font-mono text-xs text-gray-400">{open ? '▾' : '▸'}</span>
        <span className="w-5 font-mono text-sm font-bold text-indigo-600">{g.code}</span>
        <span className="flex-1 text-sm font-medium text-gray-900">{g.name}</span>
        <span className="w-40 hidden sm:block">
          <span className="block h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <span
              className={`block h-full ${w < 70 ? 'bg-red-400' : 'bg-emerald-400'}`}
              style={{ width: `${w.toFixed(1)}%` }}
            />
          </span>
        </span>
        <span className={`w-16 text-right text-sm tabular-nums ${rateClass(g.rate, g.tried)}`}>
          {g.tried ? `${g.rate}%` : '—'}
        </span>
        <span className="w-24 text-right text-xs text-gray-400 tabular-nums">
          {g.tried ? `${g.ok}/${g.tried}問` : '未挑戦'}
        </span>
      </button>

      {open && (
        <div className="bg-gray-50 border-t border-gray-100">
          {g.types.map((t) => (
            <div
              key={t.code}
              className="px-4 py-2 flex items-center gap-3 border-b border-gray-100 last:border-0"
            >
              <span className="w-5" />
              <span className="w-8 font-mono text-xs text-gray-500">{t.code}</span>
              <span className="flex-1 text-sm text-gray-700">{t.name}</span>
              <span className={`w-16 text-right text-sm tabular-nums ${rateClass(t.rate, t.tried)}`}>
                {t.tried ? `${t.rate}%` : '—'}
              </span>
              <span className="w-24 text-right text-xs text-gray-400 tabular-nums">
                {t.tried ? `${t.ok}/${t.tried}問` : `プール${t.total}問`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function BasStudentDetailPanel({
  student,
  lineAccountId,
  onBack,
}: {
  student: BasStudentRow
  lineAccountId?: string
  onBack: () => void
}) {
  const [data, setData] = useState<BasStudentDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.bas
      .student(student.friend_id, lineAccountId)
      .then((res) => {
        if (!alive) return
        setData({ dashboard: res.dashboard, recent_wrong: res.recent_wrong })
        setError('')
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : '読み込みに失敗しました'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [student.friend_id, lineAccountId])

  const d = data?.dashboard

  return (
    <div>
      <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-900 mb-4">
        ← 生徒一覧にもどる
      </button>

      <h2 className="text-lg font-semibold text-gray-900 mb-1">
        {student.display_name || '（名前なし）'}
      </h2>
      <p className="text-xs text-gray-400 mb-6 font-mono">{student.friend_id}</p>

      {loading && <p className="text-sm text-gray-500">読み込み中...</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {d && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            {[
              { label: '実施回数', value: d.sessions },
              { label: '解いた問題（延べ）', value: d.answered },
              { label: '手をつけた問題', value: `${d.tried} / ${d.pool}` },
              { label: '通算の正答率', value: d.answered ? `${d.rate}%` : '—' },
            ].map((s) => (
              <div key={s.label} className="border border-gray-200 rounded-lg px-4 py-3">
                <div className="text-xl font-semibold text-gray-900 tabular-nums">{s.value}</div>
                <div className="text-xs text-gray-500 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>

          {d.weak.length > 0 && (
            <div className="mb-6 border border-red-100 bg-red-50 rounded-lg px-4 py-3">
              <h3 className="text-sm font-semibold text-red-900 mb-2">いま落としやすい型</h3>
              <ul className="space-y-1">
                {d.weak.map((t) => (
                  <li key={t.code} className="text-sm text-red-800">
                    <span className="font-mono text-xs mr-2">{t.code}</span>
                    {t.name}
                    <span className="text-red-500 ml-2 tabular-nums">
                      {t.tried}問中 {t.tried - t.ok}問を落としています
                    </span>
                    {t.hint && <span className="block text-xs text-red-500 ml-8">{t.hint}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h3 className="text-sm font-semibold text-gray-900 mb-2">型ごとの成績</h3>
          <p className="text-xs text-gray-500 mb-2">
            1問が型を複数持つので、合計は問題数と一致しません。
            同じ問題を何度解いても、直近の1回だけを数えます。
          </p>
          <div className="border border-gray-200 rounded-lg overflow-hidden mb-6">
            {d.groups.map((g) => (
              <GroupRow key={g.code} g={g} />
            ))}
          </div>

          <h3 className="text-sm font-semibold text-gray-900 mb-2">
            いま落としたままの問題{' '}
            <span className="text-gray-400 font-normal">({data.recent_wrong.length})</span>
          </h3>
          <p className="text-xs text-gray-500 mb-2">
            あとで解き直して正解したものは出しません。
          </p>
          {data.recent_wrong.length === 0 ? (
            <p className="text-sm text-gray-500 border border-gray-200 rounded-lg px-4 py-6 text-center">
              落としたままの問題はありません。
            </p>
          ) : (
            <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 mb-6">
              {data.recent_wrong.map((w) => (
                <div key={w.question_id} className="px-4 py-3">
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="font-mono text-xs text-gray-400">No.{w.no}</span>
                    {w.timed_out === 1 && (
                      <span className="text-xs text-amber-600">時間切れ</span>
                    )}
                    <span className="ml-auto text-xs text-gray-400">
                      {fmtDateTime(w.answered_at)}
                    </span>
                  </div>
                  <div className="text-sm font-medium text-gray-900">{w.sentence}</div>
                  {w.submitted && (
                    <div className="text-sm text-red-600 mt-0.5">→ {w.submitted.join(' ')}</div>
                  )}
                  <div className="text-xs text-gray-500 mt-0.5">{w.ja}</div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {w.types.map((c) => (
                      <span
                        key={c}
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-gray-200 text-gray-500"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <h3 className="text-sm font-semibold text-gray-900 mb-2">最近のテスト</h3>
          {d.recent.length === 0 ? (
            <p className="text-sm text-gray-500">まだ実施がありません。</p>
          ) : (
            <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
              {d.recent.map((s) => (
                <div key={s.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                  <span className="text-xs text-gray-400 w-24">{fmtDateTime(s.finished_at)}</span>
                  <span className="text-gray-700 flex-1">
                    {kindLabel(s.kind, s.focus_type)}
                    {s.timer_sec > 0 && (
                      <span className="text-xs text-gray-400 ml-2">{s.timer_sec}秒</span>
                    )}
                  </span>
                  <span className="tabular-nums text-gray-900">
                    {s.correct} / {s.total}
                  </span>
                  <span className="tabular-nums text-xs text-gray-400 w-12 text-right">
                    {s.total ? Math.round((s.correct / s.total) * 100) : 0}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
