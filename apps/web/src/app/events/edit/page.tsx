'use client'

import { Suspense, useState, useEffect, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { api, type EventItem, type ConsultationConfig, type FormFieldItem } from '@/lib/api'
import type { Tag, Scenario } from '@line-crm/shared'
import Header from '@/components/layout/header'
import { useAccount } from '@/lib/account-context'
import { withGroup } from '@/lib/format-group'

const WEEKDAYS: Array<{ key: string; label: string }> = [
  { key: 'mon', label: '月' },
  { key: 'tue', label: '火' },
  { key: 'wed', label: '水' },
  { key: 'thu', label: '木' },
  { key: 'fri', label: '金' },
  { key: 'sat', label: '土' },
  { key: 'sun', label: '日' },
]

const liffIdMap: Record<string, string> = {
  'd49a3a13-8169-4b25-a669-3c8a4f4f964d': '2009821004-brTkmVVK',
  '40adcb23-277b-4d9d-b6e2-92fde47d31fb': '2006855304-UfNPHFOn',
}

function buildEventUrl(liffId: string | null, slug: string): string {
  if (!liffId || !slug) return ''
  return `https://liff.line.me/${liffId}?page=event&slug=${encodeURIComponent(slug)}&liffId=${liffId}`
}

function Inner() {
  const params = useSearchParams()
  const router = useRouter()
  const id = params.get('id') ?? ''
  const { selectedAccount } = useAccount()

  const [event, setEvent] = useState<EventItem | null>(null)
  const [config, setConfig] = useState<ConsultationConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedMsg, setSavedMsg] = useState('')
  const [calendars, setCalendars] = useState<{ id: string; calendarId: string }[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [copied, setCopied] = useState(false)
  const liffId = selectedAccount ? liffIdMap[selectedAccount.id] ?? null : null

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const accountParams = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
      const [eventRes, calRes, tagsRes, scnRes] = await Promise.all([
        api.events.get(id),
        api.googleCalendar.list(),
        api.tags.list(accountParams),
        api.scenarios.list(accountParams),
      ])
      if (eventRes.success) {
        setEvent(eventRes.data)
        setConfig(eventRes.data.consultationConfig)
      } else setError(eventRes.error)
      if (calRes.success) setCalendars(calRes.data.map(c => ({ id: c.id, calendarId: c.calendarId })))
      if (tagsRes.success) setTags(tagsRes.data)
      if (scnRes.success) setScenarios(scnRes.data)
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [id, selectedAccount])

  useEffect(() => { load() }, [load])

  const updateConfig = (patch: Partial<ConsultationConfig>) => {
    if (!config) return
    setConfig({ ...config, ...patch })
  }

  const updateBusinessHour = (key: string, value: [string, string] | null) => {
    if (!config) return
    setConfig({ ...config, businessHours: { ...config.businessHours, [key]: value } })
  }

  const handleCopyUrl = async () => {
    if (!event) return
    const url = buildEventUrl(liffId, event.slug)
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  const handleSave = async () => {
    if (!event || !config) return
    setSaving(true)
    setError('')
    setSavedMsg('')
    try {
      const res = await api.events.update(event.id, {
        name: event.name,
        description: event.description,
        slug: event.slug,
        isActive: event.isActive,
        recruitmentPaused: event.recruitmentPaused ?? false,
        funnelRole: event.funnelRole ?? null,
        eventFormat: event.eventFormat ?? null,
        consultationConfig: config,
      })
      if (res.success) {
        setSavedMsg('保存しました')
        setTimeout(() => setSavedMsg(''), 2000)
      } else {
        setError(res.error)
      }
    } catch {
      setError('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="p-8 text-center text-sm text-gray-400">読み込み中...</div>
  if (!event || !config) return <div className="p-8 text-center text-sm text-red-500">{error || 'イベントが見つかりません'}</div>

  return (
    <div>
      <Header
        title={`${event.name} の設定`}
        action={
          <div className="flex gap-2">
            <button onClick={() => router.push('/events')} className="px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded">← 一覧</button>
            <a
              href={`https://readash-liff.pages.dev/?page=event&slug=${encodeURIComponent(event.slug)}&preview=1`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-2 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded"
            >
              👁 プレビュー
            </a>
            <button onClick={handleSave} disabled={saving} className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        }
      />

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>}
      {savedMsg && <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded text-sm text-green-700">{savedMsg}</div>}

      <div className="space-y-6 max-w-3xl">
        {/* 基本 */}
        <section className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-800">基本情報</h2>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">名前</label>
            <input value={event.name} onChange={e => setEvent({ ...event, name: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">説明</label>
            <textarea value={event.description ?? ''} onChange={e => setEvent({ ...event, description: e.target.value })} rows={3} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">URLスラッグ</label>
            <input value={event.slug} onChange={e => setEvent({ ...event, slug: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">予約フォームURL</label>
            <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded px-2 py-1.5">
              <span className="flex-1 min-w-0 text-[11px] text-gray-500 font-mono truncate">
                {liffId ? buildEventUrl(liffId, event.slug) : 'LIFF ID未設定のアカウント'}
              </span>
              <button
                type="button"
                disabled={!liffId || !event.slug}
                onClick={handleCopyUrl}
                className="flex-shrink-0 text-[11px] px-2 py-0.5 rounded border border-gray-300 text-gray-600 bg-white hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {copied ? 'コピー済' : 'URLコピー'}
              </button>
            </div>
            <p className="text-[11px] text-gray-400 mt-1">LINEのテキストメッセージにそのまま貼り付け可能</p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input id="isActive" type="checkbox" checked={event.isActive} onChange={e => setEvent({ ...event, isActive: e.target.checked })} className="w-4 h-4" />
              <label htmlFor="isActive" className="text-sm text-gray-700">公開する</label>
            </div>
            <div className="flex items-start gap-2">
              <input id="recruitmentPaused" type="checkbox" checked={event.recruitmentPaused ?? false} onChange={e => setEvent({ ...event, recruitmentPaused: e.target.checked })} className="w-4 h-4 mt-0.5" />
              <label htmlFor="recruitmentPaused" className="text-sm text-gray-700">
                募集停止中（公開のまま予約枠を表示しない）
                <p className="text-[11px] text-gray-400 mt-0.5">ページは見られるが「予約可能な枠がありません」と表示。月60件キャパ超過時の一時停止用。</p>
              </label>
            </div>
          </div>

          {/* KPI / ファネル設定 */}
          <div className="grid grid-cols-2 gap-3 pt-3 border-t border-gray-100">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">ファネル役割（KPI集計用）</label>
              <select
                value={event.funnelRole ?? ''}
                onChange={e => setEvent({ ...event, funnelRole: (e.target.value || null) as 'top' | 'mid' | null })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
              >
                <option value="">集計対象外</option>
                <option value="top">top（戦略会議・勉強会など）</option>
                <option value="mid">mid（個別説明会）</option>
              </select>
              <p className="text-[11px] text-gray-400 mt-1">/kpi のファネル分析で使用</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">開催形式</label>
              <select
                value={event.eventFormat ?? ''}
                onChange={e => setEvent({ ...event, eventFormat: (e.target.value || null) as 'seminar' | 'individual' | null })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
              >
                <option value="">未設定</option>
                <option value="seminar">セミナー（集団）</option>
                <option value="individual">個別</option>
              </select>
              <p className="text-[11px] text-gray-400 mt-1">後で「セミナー vs 個別」のCVR比較に使う</p>
            </div>
          </div>
        </section>

        {/* 枠設定 */}
        <section className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-800">予約枠の設定</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">所要時間（分）</label>
              <select value={config.durationMinutes} onChange={e => updateConfig({ durationMinutes: Number(e.target.value) })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
                {[15, 30, 45, 60, 90, 120].map(m => <option key={m} value={m}>{m}分</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">後ろのインターバル（分）</label>
              <select value={config.bufferAfterMinutes} onChange={e => updateConfig({ bufferAfterMinutes: Number(e.target.value) })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
                {[0, 5, 10, 15, 30].map(m => <option key={m} value={m}>{m}分</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">前のインターバル（分）</label>
              <select value={config.bufferBeforeMinutes} onChange={e => updateConfig({ bufferBeforeMinutes: Number(e.target.value) })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
                {[0, 5, 10, 15, 30].map(m => <option key={m} value={m}>{m}分</option>)}
              </select>
            </div>
            <div />
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">最短予約（時間後から）</label>
              <input type="number" min={0} value={config.advanceMinHours} onChange={e => updateConfig({ advanceMinHours: Number(e.target.value) })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">最長予約（日先まで）</label>
              <input type="number" min={1} value={config.advanceMaxDays} onChange={e => updateConfig({ advanceMaxDays: Number(e.target.value) })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 mb-1">予約受付の最終日（任意）</label>
              <div className="flex gap-2 items-center">
                <input type="date" value={config.availableUntilDate ?? ''} onChange={e => updateConfig({ availableUntilDate: e.target.value || null })} className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                {config.availableUntilDate && (
                  <button type="button" onClick={() => updateConfig({ availableUntilDate: null })} className="text-xs text-gray-500 hover:text-gray-700">クリア</button>
                )}
              </div>
              <p className="text-[11px] text-gray-400 mt-1">指定すると、この日付までしか予約枠が表示されません（「最長予約」とAND条件）。空欄なら制限なし。</p>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">枠の表示間隔</label>
            <select value={config.slotIntervalMinutes} onChange={e => updateConfig({ slotIntervalMinutes: Number(e.target.value) })} className="w-32 border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
              {[15, 20, 30, 45, 60].map(m => <option key={m} value={m}>{m}分</option>)}
            </select>
            <p className="text-[11px] text-gray-400 mt-1">枠をどの粒度で並べるか。所要時間とは別物。例：60分枠を30分間隔で並べる</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">カレンダー表示</label>
            <div className="flex gap-2">
              <button type="button" onClick={() => updateConfig({ calendarViewMode: 'week' })} className={`text-xs px-3 py-1.5 rounded border ${config.calendarViewMode === 'week' ? 'border-[#06C755] bg-[#06C755]/10 text-[#06C755]' : 'border-gray-300 text-gray-600 bg-white'}`}>週ビュー</button>
              <button type="button" onClick={() => updateConfig({ calendarViewMode: 'month' })} className={`text-xs px-3 py-1.5 rounded border ${config.calendarViewMode === 'month' ? 'border-[#06C755] bg-[#06C755]/10 text-[#06C755]' : 'border-gray-300 text-gray-600 bg-white'}`}>月ビュー</button>
            </div>
          </div>
        </section>

        {/* 営業時間 */}
        <section className="bg-white rounded-lg border border-gray-200 p-6 space-y-3">
          <h2 className="text-sm font-semibold text-gray-800">営業時間（曜日別）</h2>
          {WEEKDAYS.map(({ key, label }) => {
            const range = config.businessHours[key]
            const enabled = !!range
            return (
              <div key={key} className="flex items-center gap-3">
                <div className="w-12 text-sm text-gray-700">{label}</div>
                <input type="checkbox" checked={enabled} onChange={e => updateBusinessHour(key, e.target.checked ? ['10:00', '18:00'] : null)} className="w-4 h-4" />
                {enabled && range && (
                  <>
                    <input type="time" value={range[0]} onChange={e => updateBusinessHour(key, [e.target.value, range[1]])} className="border border-gray-300 rounded px-2 py-1 text-sm" />
                    <span className="text-gray-400">〜</span>
                    <input type="time" value={range[1]} onChange={e => updateBusinessHour(key, [range[0], e.target.value])} className="border border-gray-300 rounded px-2 py-1 text-sm" />
                  </>
                )}
                {!enabled && <span className="text-xs text-gray-400">休業</span>}
              </div>
            )
          })}
          <div className="border-t border-gray-100 pt-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">休業日（カンマ区切り、YYYY-MM-DD）</label>
            <input
              type="text"
              value={config.blackoutDates.join(', ')}
              onChange={e => updateConfig({ blackoutDates: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
              placeholder="2026-05-03, 2026-05-04"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
            />
          </div>
        </section>

        {/* 連携 */}
        <section className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-800">連携</h2>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Google Calendar <span className="text-red-500">*</span></label>
            <select value={config.googleCalendarConnectionId ?? ''} onChange={e => updateConfig({ googleCalendarConnectionId: e.target.value || null })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
              <option value="">選択してください</option>
              {calendars.map(c => <option key={c.id} value={c.id}>{c.calendarId}</option>)}
            </select>
            {calendars.length === 0 && <p className="text-[11px] text-amber-600 mt-1">連携されたカレンダーがありません。設定 → Google Calendar で接続してください</p>}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Zoom URL の補足は下のセクションから</label>
            <p className="text-[11px] text-gray-400">予約申込フォームはこの設定画面の「予約申込フォーム」セクションで個別に作成します（フォームタブとは独立）</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Zoom URL（任意）</label>
            <input type="url" value={config.zoomUrl ?? ''} onChange={e => updateConfig({ zoomUrl: e.target.value || null })} placeholder="https://us02web.zoom.us/j/xxxxxxxxx" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            <p className="text-[11px] text-gray-400 mt-1">設定すると予約完了通知・リマインダーに自動でURLが含まれます</p>
          </div>
        </section>

        {/* 予約申込フォーム */}
        <section className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-800">予約申込フォーム（任意）</h2>
            <button
              type="button"
              onClick={() => updateConfig({ bookingFormFields: [...config.bookingFormFields, { name: `field_${Math.random().toString(36).slice(2, 8)}`, label: '', type: 'text', required: false, options: [] }] })}
              className="text-xs px-3 py-1 rounded bg-gray-100 hover:bg-gray-200"
            >+ 項目追加</button>
          </div>
          <p className="text-[11px] text-gray-400">日程選択後に表示される質問項目。空のままなら申込フォームはスキップされます</p>
          {config.bookingFormFields.length > 0 && (
            <div className="space-y-3">
              {config.bookingFormFields.map((f, idx) => (
                <BookingFieldEditor
                  key={f.name}
                  field={f}
                  onChange={(next) => updateConfig({ bookingFormFields: config.bookingFormFields.map((x, i) => i === idx ? next : x) })}
                  onRemove={() => updateConfig({ bookingFormFields: config.bookingFormFields.filter((_, i) => i !== idx) })}
                  onMove={(dir) => {
                    const target = idx + dir
                    if (target < 0 || target >= config.bookingFormFields.length) return
                    const next = [...config.bookingFormFields]
                    ;[next[idx], next[target]] = [next[target], next[idx]]
                    updateConfig({ bookingFormFields: next })
                  }}
                />
              ))}
            </div>
          )}
          {config.bookingFormFields.length > 0 && (
            <div className="border-t border-gray-100 pt-3">
              <label className="block text-xs font-medium text-gray-600 mb-1">送信ボタンの文言（任意）</label>
              <input
                type="text"
                value={config.bookingFormSubmitLabel ?? ''}
                onChange={e => updateConfig({ bookingFormSubmitLabel: e.target.value || null })}
                placeholder="例: 申し込む"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
              <p className="text-[11px] text-gray-400 mt-1">空欄なら「予約を確定する」</p>
            </div>
          )}
        </section>

        {/* 予約完了アクション */}
        <section className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-800">予約完了時のアクション</h2>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">付与するタグ</label>
            <select value={config.onCompleteTagId ?? ''} onChange={e => updateConfig({ onCompleteTagId: e.target.value || null })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
              <option value="">なし</option>
              {tags.map(t => <option key={t.id} value={t.id}>{withGroup(t.name, t.groupName)}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">発火するシナリオ</label>
            <select value={config.onCompleteScenarioId ?? ''} onChange={e => updateConfig({ onCompleteScenarioId: e.target.value || null })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
              <option value="">なし</option>
              {scenarios.map(s => <option key={s.id} value={s.id}>{withGroup(s.name, s.groupName)}</option>)}
            </select>
          </div>
        </section>

        {/* リマインダー */}
        <section className="bg-white rounded-lg border border-gray-200 p-6 space-y-3">
          <h2 className="text-sm font-semibold text-gray-800">リマインダー</h2>
          <div className="flex items-center gap-3">
            <input type="checkbox" checked={config.reminderDayBefore} onChange={e => updateConfig({ reminderDayBefore: e.target.checked })} className="w-4 h-4" />
            <span className="text-sm text-gray-700">前日リマインダー</span>
            <input type="time" value={config.reminderDayBeforeAt} onChange={e => updateConfig({ reminderDayBeforeAt: e.target.value })} className="border border-gray-300 rounded px-2 py-1 text-sm" />
            <span className="text-xs text-gray-500">に送信</span>
          </div>
          <div className="flex items-center gap-3">
            <input type="checkbox" checked={config.reminderHourBefore} onChange={e => updateConfig({ reminderHourBefore: e.target.checked })} className="w-4 h-4" />
            <span className="text-sm text-gray-700">直前リマインダー：開始の</span>
            <input type="number" min={5} max={240} value={config.reminderHourBeforeMinutes} onChange={e => updateConfig({ reminderHourBeforeMinutes: Number(e.target.value) })} className="w-20 border border-gray-300 rounded px-2 py-1 text-sm" />
            <span className="text-xs text-gray-500">分前</span>
          </div>

          <div className="border-t border-gray-100 pt-4 space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">予約完了通知の文面（任意）</label>
              <textarea
                value={config.confirmationMessage ?? ''}
                onChange={e => updateConfig({ confirmationMessage: e.target.value || null })}
                rows={4}
                placeholder={'空欄ならデフォルト文を使用\n\n使えるプレースホルダー:\n  {event}    イベント名\n  {datetime} 予約日時\n  {zoom}     Zoom URL\n  {name}     友だちの表示名'}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none whitespace-pre-wrap"
              />
              <p className="text-[11px] text-gray-400 mt-1">予約確定直後にLINEで送られるメッセージ</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">前日リマインダーの文面（任意）</label>
              <textarea
                value={config.reminderDayBeforeMessage ?? ''}
                onChange={e => updateConfig({ reminderDayBeforeMessage: e.target.value || null })}
                rows={4}
                placeholder={'空欄ならデフォルト文を使用\n\n使えるプレースホルダー:\n  {event}    イベント名\n  {datetime} 予約日時\n  {zoom}     Zoom URL'}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none whitespace-pre-wrap"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">直前リマインダーの文面（任意）</label>
              <textarea
                value={config.reminderHourBeforeMessage ?? ''}
                onChange={e => updateConfig({ reminderHourBeforeMessage: e.target.value || null })}
                rows={4}
                placeholder={'空欄ならデフォルト文を使用\n\n使えるプレースホルダー:\n  {event}    イベント名\n  {datetime} 予約日時\n  {zoom}     Zoom URL\n  {minutes}  何分前か'}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none whitespace-pre-wrap"
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

const FIELD_TYPES: Array<{ value: FormFieldItem['type']; label: string; needsOptions?: boolean }> = [
  { value: 'text', label: 'テキスト1行' },
  { value: 'textarea', label: 'テキスト複数行' },
  { value: 'radio', label: '単一選択（ラジオ）', needsOptions: true },
  { value: 'select', label: 'プルダウン', needsOptions: true },
  { value: 'checkbox', label: '複数選択（チェック）', needsOptions: true },
  { value: 'email', label: 'メール' },
  { value: 'tel', label: '電話番号' },
  { value: 'number', label: '数値' },
  { value: 'date', label: '日付' },
]

function BookingFieldEditor({
  field,
  onChange,
  onRemove,
  onMove,
}: {
  field: FormFieldItem
  onChange: (next: FormFieldItem) => void
  onRemove: () => void
  onMove: (dir: -1 | 1) => void
}) {
  const def = FIELD_TYPES.find(t => t.value === field.type)
  return (
    <div className="border border-gray-200 rounded p-3 bg-gray-50 space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <input
          type="text"
          value={field.label}
          onChange={e => onChange({ ...field, label: e.target.value })}
          placeholder="質問文（例: 学年）"
          className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
        />
        <select
          value={field.type}
          onChange={e => {
            const nextType = e.target.value as FormFieldItem['type']
            const needsOpts = ['radio', 'select', 'checkbox'].includes(nextType)
            const seeded = field.options && field.options.length > 0 ? field.options : ['', '']
            onChange({ ...field, type: nextType, options: needsOpts ? seeded : field.options })
          }}
          className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
        >
          {FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>
      {def?.needsOptions && (
        <div className="space-y-1">
          {(field.options ?? []).map((opt, oi) => (
            <div key={oi} className="flex items-center gap-1">
              <input
                type="text"
                value={opt}
                onChange={e => {
                  const next = (field.options ?? []).map((o, i) => i === oi ? e.target.value : o)
                  onChange({ ...field, options: next })
                }}
                placeholder={`選択肢 ${oi + 1}`}
                className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs bg-white"
              />
              <button
                onClick={() => onChange({ ...field, options: (field.options ?? []).filter((_, i) => i !== oi) })}
                className="text-xs text-red-400 hover:text-red-600 px-1"
              >×</button>
            </div>
          ))}
          <button
            onClick={() => onChange({ ...field, options: [...(field.options ?? []), ''] })}
            className="text-xs text-gray-500 hover:text-gray-700"
          >+ 選択肢追加</button>
        </div>
      )}
      <div className="flex items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={field.required ?? false} onChange={e => onChange({ ...field, required: e.target.checked })} />
          必須
        </label>
        <button onClick={() => onMove(-1)} className="text-gray-500 hover:text-gray-700">↑</button>
        <button onClick={() => onMove(1)} className="text-gray-500 hover:text-gray-700">↓</button>
        <button onClick={onRemove} className="text-red-400 hover:text-red-600 ml-auto">削除</button>
      </div>
    </div>
  )
}

export default function EventEditPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-sm text-gray-400">読み込み中...</div>}>
      <Inner />
    </Suspense>
  )
}
