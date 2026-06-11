'use client'

import { useEffect, useState } from 'react'
import { api, type KpiFunnelSummary } from '@/lib/api'
import Header from '@/components/layout/header'
import { useAccount } from '@/lib/account-context'

export default function KpiPage() {
  const { selectedAccount } = useAccount()
  const [days, setDays] = useState(30)
  const [data, setData] = useState<KpiFunnelSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    api.kpi
      .funnelSummary({ ...(selectedAccount ? { lineAccountId: selectedAccount.id } : {}), days })
      .then((res) => {
        if (cancelled) return
        if (res.success) setData(res.data)
        else setError(res.error)
      })
      .catch(() => { if (!cancelled) setError('KPIデータの取得に失敗しました') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [selectedAccount, days])

  const pct = (num: number, denom: number) => {
    if (denom <= 0) return '—'
    return ((num / denom) * 100).toFixed(1) + '%'
  }
  const yen = (n: number) => '¥' + n.toLocaleString()

  return (
    <>
      <Header title="KPI / ファネル分析" description="流入 → top → 個別説明会 → 成約 の各段階を可視化" />
      <main className="px-6 py-6">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-end mb-4 flex-wrap gap-2">
            <div className="flex gap-2 items-center">
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="text-xs border border-gray-300 rounded-md px-2 py-1 bg-white"
              >
                <option value={7}>過去7日</option>
                <option value={14}>過去14日</option>
                <option value={30}>過去30日</option>
                <option value={60}>過去60日</option>
                <option value={90}>過去90日</option>
              </select>
            </div>
          </div>

          {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
          {loading && <p className="text-xs text-gray-500">読み込み中…</p>}

          {data && (
            <>
              <p className="text-[11px] text-gray-400 mb-3">
                期間: {data.period.from} 〜 {data.period.to}（{data.period.days}日間）
              </p>

              {/* 全体ファネル */}
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 mb-6">
                <h2 className="text-sm font-bold text-gray-800 mb-4">全体サマリー</h2>
                <div className="grid grid-cols-4 gap-3">
                  <FunnelCard label="流入（友達追加）" value={data.overall.friendsAdded.toLocaleString()} sub="" color="green" />
                  <FunnelCard
                    label="top イベント参加"
                    value={data.overall.topUniqueFriends.toLocaleString()}
                    sub={`CVR: ${pct(data.overall.topUniqueFriends, data.overall.friendsAdded)}`}
                    color="blue"
                  />
                  <FunnelCard
                    label="個別説明会"
                    value={data.overall.midUniqueFriends.toLocaleString()}
                    sub={`top→mid: ${pct(data.overall.midUniqueFriends, data.overall.topUniqueFriends)}`}
                    color="indigo"
                  />
                  <FunnelCard
                    label="成約"
                    value={data.overall.closedFriends.toLocaleString()}
                    sub={`mid→成約: ${pct(data.overall.closedFriends, data.overall.midUniqueFriends)}`}
                    color="amber"
                  />
                </div>
                <div className="mt-4 pt-4 border-t border-gray-100 grid grid-cols-2 gap-3 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500">期間売上</span>
                    <span className="text-base font-bold text-amber-700">{yen(data.overall.revenue)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500">流入→成約 全体CVR</span>
                    <span className="text-base font-bold text-gray-700">{pct(data.overall.closedFriends, data.overall.friendsAdded)}</span>
                  </div>
                </div>
              </div>

              {/* top 別 breakdown */}
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
                <h2 className="text-sm font-bold text-gray-800 mb-1">topイベント別の比較</h2>
                <p className="text-[11px] text-gray-500 mb-4">
                  どの企画（top）が成約まで一番ハネるか。「topに来た distinct friend」を起点に各CVRを計算。
                </p>
                {data.topBreakdown.length === 0 ? (
                  <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-800">
                    まだ <code className="bg-white px-1.5 py-0.5 rounded">funnel_role = top</code> のイベントが登録されていません。<br />
                    /events/edit でイベントごとに「ファネル役割」を設定すると、ここに比較表が出ます。
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50 border-b border-gray-200 text-xs text-gray-500">
                          <th className="text-left px-3 py-2 font-semibold">top イベント</th>
                          <th className="text-left px-3 py-2 font-semibold">形式</th>
                          <th className="text-right px-3 py-2 font-semibold">top参加</th>
                          <th className="text-right px-3 py-2 font-semibold">→ 説明会</th>
                          <th className="text-right px-3 py-2 font-semibold">→ 成約</th>
                          <th className="text-right px-3 py-2 font-semibold">説明会CVR</th>
                          <th className="text-right px-3 py-2 font-semibold">成約CVR</th>
                          <th className="text-right px-3 py-2 font-semibold">売上</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {data.topBreakdown.map((row) => (
                          <tr key={row.eventId} className="hover:bg-gray-50">
                            <td className="px-3 py-2 text-gray-900">{row.name}</td>
                            <td className="px-3 py-2 text-xs text-gray-500">
                              {row.eventFormat === 'seminar' ? 'セミナー' : row.eventFormat === 'individual' ? '個別' : '—'}
                            </td>
                            <td className="px-3 py-2 text-right text-gray-900 font-semibold">{row.topUniqueFriends.toLocaleString()}</td>
                            <td className="px-3 py-2 text-right">{row.midUniqueFriends.toLocaleString()}</td>
                            <td className="px-3 py-2 text-right">{row.closedFriends.toLocaleString()}</td>
                            <td className="px-3 py-2 text-right text-indigo-600 font-semibold">{pct(row.midUniqueFriends, row.topUniqueFriends)}</td>
                            <td className="px-3 py-2 text-right text-amber-700 font-semibold">{pct(row.closedFriends, row.topUniqueFriends)}</td>
                            <td className="px-3 py-2 text-right text-amber-700 font-semibold">{yen(row.revenue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </>
  )
}

function FunnelCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: 'green' | 'blue' | 'indigo' | 'amber' }) {
  const tone = {
    green: 'bg-green-50 text-green-700',
    blue: 'bg-blue-50 text-blue-700',
    indigo: 'bg-indigo-50 text-indigo-700',
    amber: 'bg-amber-50 text-amber-700',
  }[color]
  return (
    <div className={`rounded-md p-3 ${tone}`}>
      <p className="text-[11px] opacity-70 leading-tight">{label}</p>
      <p className="text-2xl font-bold leading-tight mt-1">{value}</p>
      {sub && <p className="text-[11px] opacity-70 mt-1 leading-tight">{sub}</p>}
    </div>
  )
}
