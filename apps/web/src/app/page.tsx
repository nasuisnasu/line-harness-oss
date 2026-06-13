'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { api, type EventItem } from '@/lib/api'
import CcPromptButton from '@/components/cc-prompt-button'
import { useAccount } from '@/lib/account-context'

const ccPrompts = [
  {
    title: 'ダッシュボードのKPI分析',
    prompt: `LINE CRM ダッシュボードのデータを分析してください。
1. 友だち数の推移を確認
2. アクティブシナリオの効果を評価
3. 配信の開封率・クリック率を分析
改善提案を含めてレポートしてください。`,
  },
  {
    title: '新しいシナリオを提案',
    prompt: `現在の友だちデータとタグ情報を元に、効果的なシナリオ配信を提案してください。
1. ターゲットセグメントの特定
2. メッセージ内容の提案
3. 配信タイミングの最適化
具体的なステップ配信の構成を含めてください。`,
  },
]

interface DashboardStats {
  friendCount: number | null
  activeScenarioCount: number | null
  broadcastCount: number | null
  templateCount: number | null
  automationCount: number | null
  scoringRuleCount: number | null
}

interface StatCardProps {
  title: string
  value: number | null
  loading: boolean
  icon: React.ReactNode
  href: string
  accentColor?: string
}

function StatCard({ title, value, loading, icon, href, accentColor = '#06C755' }: StatCardProps) {
  return (
    <Link href={href} className="block bg-white rounded-lg shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow group">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500 mb-2">{title}</p>
          {loading ? (
            <div className="h-8 w-20 bg-gray-100 rounded animate-pulse" />
          ) : (
            <p className="text-3xl font-bold text-gray-900">
              {value !== null ? value.toLocaleString('ja-JP') : '-'}
            </p>
          )}
        </div>
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center text-white shrink-0"
          style={{ backgroundColor: accentColor }}
        >
          {icon}
        </div>
      </div>
      <p className="text-xs text-gray-400 mt-3 group-hover:text-green-600 transition-colors">
        詳細を見る →
      </p>
    </Link>
  )
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats>({
    friendCount: null,
    activeScenarioCount: null,
    broadcastCount: null,
    templateCount: null,
    automationCount: null,
    scoringRuleCount: null,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const { selectedAccount } = useAccount()

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const accountParams = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
        const [friendCountRes, scenariosRes, broadcastsRes, templatesRes, automationsRes, scoringRes] = await Promise.allSettled([
          api.friends.count(accountParams),
          api.scenarios.list(accountParams),
          api.broadcasts.list(accountParams),
          api.templates.list(),
          api.automations.list(),
          api.scoring.rules(),
        ])

        setStats({
          friendCount:
            friendCountRes.status === 'fulfilled' && friendCountRes.value.success
              ? friendCountRes.value.data.count
              : null,
          activeScenarioCount:
            scenariosRes.status === 'fulfilled' && scenariosRes.value.success
              ? scenariosRes.value.data.filter((s) => s.isActive).length
              : null,
          broadcastCount:
            broadcastsRes.status === 'fulfilled' && broadcastsRes.value.success
              ? broadcastsRes.value.data.length
              : null,
          templateCount:
            templatesRes.status === 'fulfilled' && templatesRes.value.success
              ? templatesRes.value.data.length
              : null,
          automationCount:
            automationsRes.status === 'fulfilled' && automationsRes.value.success
              ? automationsRes.value.data.filter((a) => a.isActive).length
              : null,
          scoringRuleCount:
            scoringRes.status === 'fulfilled' && scoringRes.value.success
              ? scoringRes.value.data.length
              : null,
        })
      } catch {
        setError('データの読み込みに失敗しました')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [selectedAccount])

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">ダッシュボード</h1>
        <p className="text-sm text-gray-500 mt-1">LINE公式アカウント CRM 管理画面</p>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 mb-8">
        <StatCard
          title="友だち数"
          value={stats.friendCount}
          loading={loading}
          href="/friends"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          }
        />
        <StatCard
          title="アクティブシナリオ数"
          value={stats.activeScenarioCount}
          loading={loading}
          href="/scenarios"
          accentColor="#3B82F6"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          }
        />
        <StatCard
          title="配信数 (合計)"
          value={stats.broadcastCount}
          loading={loading}
          href="/broadcasts"
          accentColor="#8B5CF6"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
            </svg>
          }
        />
      </div>

      {/* Round 3 summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 mb-8">
        <StatCard
          title="テンプレート数"
          value={stats.templateCount}
          loading={loading}
          href="/templates"
          accentColor="#F59E0B"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6z" />
            </svg>
          }
        />
        <StatCard
          title="アクティブルール数"
          value={stats.automationCount}
          loading={loading}
          href="/automations"
          accentColor="#EF4444"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          }
        />
        <StatCard
          title="スコアリングルール数"
          value={stats.scoringRuleCount}
          loading={loading}
          href="/scoring"
          accentColor="#10B981"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
          }
        />
      </div>

      {/* 日別友達推移テーブル */}
      <DailyFriendStats lineAccountId={selectedAccount?.id ?? null} />

      {/* Quick links */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-gray-800 mb-4">クイックアクション</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Link
            href="/friends"
            className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-green-300 hover:bg-green-50 transition-colors group"
          >
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white shrink-0" style={{ backgroundColor: '#06C755' }}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900 group-hover:text-green-700 transition-colors">友だち管理</p>
              <p className="text-xs text-gray-400">友だちの一覧・タグ管理</p>
            </div>
          </Link>

          <Link
            href="/scenarios"
            className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-colors group"
          >
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white shrink-0 bg-blue-500">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900 group-hover:text-blue-700 transition-colors">シナリオ配信</p>
              <p className="text-xs text-gray-400">自動配信シナリオの作成・編集</p>
            </div>
          </Link>

          <Link
            href="/broadcasts"
            className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-purple-300 hover:bg-purple-50 transition-colors group"
          >
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white shrink-0 bg-purple-500">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900 group-hover:text-purple-700 transition-colors">一斉配信</p>
              <p className="text-xs text-gray-400">メッセージの一斉送信・予約</p>
            </div>
          </Link>

          <Link
            href="/chats"
            className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-green-300 hover:bg-green-50 transition-colors group"
          >
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white shrink-0" style={{ backgroundColor: '#06C755' }}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900 group-hover:text-green-700 transition-colors">チャット</p>
              <p className="text-xs text-gray-400">オペレーターチャット管理</p>
            </div>
          </Link>

          <Link
            href="/health"
            className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-red-300 hover:bg-red-50 transition-colors group"
          >
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white shrink-0 bg-red-500">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900 group-hover:text-red-700 transition-colors">BAN検知</p>
              <p className="text-xs text-gray-400">アカウント健康度ダッシュボード</p>
            </div>
          </Link>
        </div>
      </div>

      <CcPromptButton prompts={ccPrompts} />
    </div>
  )
}

interface DailyStatRow { date: string; added: number; blocked: number; cumulative: number; bookings: number; paymentSum: number }

function DailyFriendStats({ lineAccountId }: { lineAccountId: string | null }) {
  const [rows, setRows] = useState<DailyStatRow[]>([])
  const [days, setDays] = useState(14)
  // 画面共有時に売上を見せたくないので、表示はトグル可（localStorage 保存）
  const [showRevenue, setShowRevenue] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    return localStorage.getItem('dashboard.showRevenue') !== '0'
  })
  const toggleRevenue = () => {
    setShowRevenue((v) => {
      const next = !v
      try { localStorage.setItem('dashboard.showRevenue', next ? '1' : '0') } catch {}
      return next
    })
  }
  const [events, setEvents] = useState<EventItem[]>([])
  const [eventId, setEventId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lifetime, setLifetime] = useState<{ friendsAdded: number; bookings: number; paymentSum: number } | null>(null)

  // 申込み絞り込み用のイベント一覧（相談系イベント）。アカウント切替で選択リセット。
  useEffect(() => {
    setEventId('')
    const params = lineAccountId ? { lineAccountId } : undefined
    api.events.list(params)
      .then((res) => { if (res.success) setEvents(res.data) })
      .catch(() => {})
  }, [lineAccountId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    api.friends
      .dailyStats({ ...(lineAccountId ? { lineAccountId } : {}), days, ...(eventId ? { eventId } : {}) })
      .then((res) => {
        if (cancelled) return
        if (res.success) setRows(res.data)
        else setError(res.error)
      })
      .catch(() => { if (!cancelled) setError('日別データの取得に失敗しました') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [lineAccountId, days, eventId])

  // LIFETIME 合計（期間切り替えに影響しないので別 effect）
  useEffect(() => {
    let cancelled = false
    api.friends
      .lifetimeSummary({ ...(lineAccountId ? { lineAccountId } : {}), ...(eventId ? { eventId } : {}) })
      .then((res) => {
        if (cancelled) return
        if (res.success) setLifetime(res.data)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [lineAccountId, eventId])

  const totalAdded = rows.reduce((s, r) => s + r.added, 0)
  const totalBookings = rows.reduce((s, r) => s + r.bookings, 0)
  const totalPayment = rows.reduce((s, r) => s + (r.paymentSum ?? 0), 0)
  const formatYen = (n: number) => '¥' + n.toLocaleString()

  const formatDate = (iso: string) => {
    const d = new Date(iso + 'T00:00:00+09:00')
    const wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()]
    return `${d.getMonth() + 1}/${d.getDate()}(${wd})`
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-8">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-gray-800">日別 友達追加・申込み推移</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
            className="text-xs border border-gray-300 rounded-md px-2 py-1 bg-white"
          >
            <option value="">申込み: すべて</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>申込み: {ev.name}</option>
            ))}
          </select>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="text-xs border border-gray-300 rounded-md px-2 py-1 bg-white"
          >
            <option value={7}>過去7日</option>
            <option value={14}>過去14日</option>
            <option value={30}>過去30日</option>
            <option value={60}>過去60日</option>
          </select>
          <button
            onClick={toggleRevenue}
            title={showRevenue ? '売上を隠す（画面共有時など）' : '売上を表示する'}
            className="text-xs border border-gray-300 rounded-md px-2 py-1 bg-white hover:bg-gray-50"
          >
            {showRevenue ? '💰 売上 表示中' : '🙈 売上 非表示'}
          </button>
        </div>
      </div>

      {/* 期間合計サマリー */}
      {!loading && (
        <div className="flex gap-3 mb-3 flex-wrap">
          <div className="flex items-baseline gap-1.5 px-3 py-1.5 rounded-md bg-green-50">
            <span className="text-xs text-gray-500">期間の友達追加</span>
            <span className="text-base font-bold text-green-600">+{totalAdded}</span>
          </div>
          <div className="flex items-baseline gap-1.5 px-3 py-1.5 rounded-md bg-blue-50">
            <span className="text-xs text-gray-500">期間の申込み</span>
            <span className="text-base font-bold text-blue-600">{totalBookings}</span>
          </div>
          {showRevenue && (
            <div className="flex items-baseline gap-1.5 px-3 py-1.5 rounded-md bg-amber-50">
              <span className="text-xs text-gray-500">期間の売上</span>
              <span className="text-base font-bold text-amber-700">{formatYen(totalPayment)}</span>
            </div>
          )}
        </div>
      )}

      {/* LIFETIME サマリー */}
      {lifetime && (
        <div className="flex gap-3 mb-3 flex-wrap items-center">
          <span className="text-[10px] tracking-[0.2em] font-bold text-gray-400">LIFETIME</span>
          <div className="flex items-baseline gap-1.5 px-3 py-1.5 rounded-md bg-gray-50 border border-gray-200">
            <span className="text-xs text-gray-500">累計の友達追加</span>
            <span className="text-base font-bold text-gray-700">{lifetime.friendsAdded.toLocaleString()}</span>
          </div>
          <div className="flex items-baseline gap-1.5 px-3 py-1.5 rounded-md bg-gray-50 border border-gray-200">
            <span className="text-xs text-gray-500">累計の申込み</span>
            <span className="text-base font-bold text-gray-700">{lifetime.bookings.toLocaleString()}</span>
          </div>
          {showRevenue && (
            <div className="flex items-baseline gap-1.5 px-3 py-1.5 rounded-md bg-gray-50 border border-gray-200">
              <span className="text-xs text-gray-500">累計の売上</span>
              <span className="text-base font-bold text-gray-700">{formatYen(lifetime.paymentSum)}</span>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[440px] text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-xs text-gray-500">
              <th className="text-left px-3 py-2 font-semibold">日付</th>
              <th className="text-right px-3 py-2 font-semibold">新規追加</th>
              <th className="text-right px-3 py-2 font-semibold">申込み</th>
              {showRevenue && <th className="text-right px-3 py-2 font-semibold">売上</th>}
              <th className="text-right px-3 py-2 font-semibold">ブロック</th>
              <th className="text-right px-3 py-2 font-semibold">累計（有効）</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              [...Array(5)].map((_, i) => (
                <tr key={i}>
                  <td className="px-3 py-2"><div className="h-3 bg-gray-100 rounded w-16 animate-pulse" /></td>
                  <td className="px-3 py-2 text-right"><div className="h-3 bg-gray-100 rounded w-8 ml-auto animate-pulse" /></td>
                  <td className="px-3 py-2 text-right"><div className="h-3 bg-gray-100 rounded w-8 ml-auto animate-pulse" /></td>
                  {showRevenue && <td className="px-3 py-2 text-right"><div className="h-3 bg-gray-100 rounded w-12 ml-auto animate-pulse" /></td>}
                  <td className="px-3 py-2 text-right"><div className="h-3 bg-gray-100 rounded w-8 ml-auto animate-pulse" /></td>
                  <td className="px-3 py-2 text-right"><div className="h-3 bg-gray-100 rounded w-10 ml-auto animate-pulse" /></td>
                </tr>
              ))
            ) : (
              rows.slice().reverse().map((r) => (
                <tr key={r.date} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-gray-700">{formatDate(r.date)}</td>
                  <td className="px-3 py-2 text-right">
                    {r.added > 0 ? <span className="text-green-600 font-semibold">+{r.added}</span> : <span className="text-gray-300">0</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.bookings > 0 ? <span className="text-blue-600 font-semibold">{r.bookings}</span> : <span className="text-gray-300">0</span>}
                  </td>
                  {showRevenue && (
                    <td className="px-3 py-2 text-right">
                      {(r.paymentSum ?? 0) > 0 ? <span className="text-amber-700 font-semibold">{formatYen(r.paymentSum)}</span> : <span className="text-gray-300">¥0</span>}
                    </td>
                  )}
                  <td className="px-3 py-2 text-right">
                    {r.blocked > 0 ? <span className="text-red-500 font-semibold">-{r.blocked}</span> : <span className="text-gray-300">0</span>}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-900 font-semibold">{r.cumulative}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
