'use client'

import { useEffect, useState, useCallback } from 'react'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import { useAccount } from '@/lib/account-context'

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

// アカウント→LIFF ID（entry-routes/page.tsx と同じ対応表）
const LIFF_ID_MAP: Record<string, string> = {
  'd49a3a13-8169-4b25-a669-3c8a4f4f964d': '2009821004-brTkmVVK',
  '40adcb23-277b-4d9d-b6e2-92fde47d31fb': '2006855304-UfNPHFOn',
  '5185b739-88d7-40eb-a3b5-f7e61ef8fa5e': '2009506707-tX5TQVsB',
}

function dateToString(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export default function BusinessCalendarPage() {
  const { selectedAccount } = useAccount()
  const [year, setYear] = useState(new Date().getFullYear())
  const [month, setMonth] = useState(new Date().getMonth())
  const [closedWeekdays, setClosedWeekdays] = useState<number[]>([])
  const [closedDates, setClosedDates] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    if (!selectedAccount) return
    setLoading(true)
    setError('')
    try {
      const res = await api.businessCalendar.get(selectedAccount.id)
      if (res.success) {
        setClosedWeekdays(res.data.closedWeekdays ?? [])
        setClosedDates(res.data.closedDates ?? [])
        setNotice(res.data.notice ?? '')
      } else {
        setError(res.error)
      }
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccount])

  useEffect(() => { load() }, [load])

  const toggleDate = (dateStr: string) => {
    setSaved(false)
    setClosedDates((prev) =>
      prev.includes(dateStr) ? prev.filter((d) => d !== dateStr) : [...prev, dateStr],
    )
  }

  const toggleWeekday = (wd: number) => {
    setSaved(false)
    setClosedWeekdays((prev) =>
      prev.includes(wd) ? prev.filter((d) => d !== wd) : [...prev, wd],
    )
  }

  const handleSave = async () => {
    if (!selectedAccount) return
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const res = await api.businessCalendar.update(selectedAccount.id, {
        closedWeekdays,
        closedDates: [...closedDates].sort(),
        notice: notice.trim() || null,
      })
      if (res.success) setSaved(true)
      else setError(res.error)
    } catch {
      setError('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const liffId = selectedAccount ? LIFF_ID_MAP[selectedAccount.id] : undefined
  const liffUrl = liffId && selectedAccount
    ? `https://liff.line.me/${liffId}?page=schedule&liffId=${liffId}&lineAccountId=${selectedAccount.id}`
    : ''

  const isClosed = (day: number): boolean => {
    const dateStr = dateToString(year, month, day)
    if (closedDates.includes(dateStr)) return true
    return closedWeekdays.includes(new Date(year, month, day).getDay())
  }
  const isWeeklyClosed = (day: number): boolean =>
    closedWeekdays.includes(new Date(year, month, day).getDay())

  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const firstDay = new Date(year, month, 1).getDay()
  const prevMonth = () => { if (month === 0) { setMonth(11); setYear((y) => y - 1) } else setMonth((m) => m - 1) }
  const nextMonth = () => { if (month === 11) { setMonth(0); setYear((y) => y + 1) } else setMonth((m) => m + 1) }

  return (
    <>
      <Header title="営業カレンダー（休業日）" description="休業日を設定すると、リッチメニューの営業カレンダーで生徒が確認できます" />
      <main className="px-6 py-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {error && <p className="text-xs text-red-600">{error}</p>}
          {loading ? (
            <p className="text-sm text-gray-500">読み込み中…</p>
          ) : (
            <>
              {/* カレンダー */}
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <p className="text-xs text-gray-500 mb-3">日付をクリックすると、その日を休業日にできます（もう一度で解除）。赤は休業日。</p>
                <div className="flex items-center justify-between mb-3">
                  <button onClick={prevMonth} className="px-3 py-1 text-sm text-gray-600 hover:bg-gray-100 rounded">&lt;</button>
                  <span className="text-sm font-bold text-gray-800">{year}年{month + 1}月</span>
                  <button onClick={nextMonth} className="px-3 py-1 text-sm text-gray-600 hover:bg-gray-100 rounded">&gt;</button>
                </div>
                <div className="grid grid-cols-7 gap-1 text-center mb-1">
                  {WEEKDAYS.map((d, i) => (
                    <span key={d} className={`text-xs font-semibold ${i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-gray-500'}`}>{d}</span>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {Array.from({ length: firstDay }).map((_, i) => <span key={`e${i}`} />)}
                  {Array.from({ length: daysInMonth }).map((_, i) => {
                    const day = i + 1
                    const dateStr = dateToString(year, month, day)
                    const closed = isClosed(day)
                    const weekly = isWeeklyClosed(day)
                    return (
                      <button
                        key={day}
                        onClick={() => toggleDate(dateStr)}
                        title={weekly ? '毎週の固定休（曜日設定）' : ''}
                        className={`aspect-square rounded text-sm flex items-center justify-center transition-colors ${
                          closed
                            ? 'bg-red-100 text-red-700 font-bold hover:bg-red-200'
                            : 'hover:bg-gray-100 text-gray-700'
                        } ${weekly ? 'ring-1 ring-red-200' : ''}`}
                      >
                        {day}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* 毎週の固定休 */}
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <h2 className="text-sm font-bold text-gray-800 mb-1">毎週の固定休</h2>
                <p className="text-xs text-gray-500 mb-3">毎週決まって休む曜日（例：日曜）。入力忘れ防止用。</p>
                <div className="flex gap-2">
                  {WEEKDAYS.map((d, wd) => (
                    <button
                      key={wd}
                      onClick={() => toggleWeekday(wd)}
                      className={`w-10 h-10 rounded-full text-sm font-medium transition-colors ${
                        closedWeekdays.includes(wd)
                          ? 'bg-red-500 text-white'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>

              {/* 注意書き */}
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <h2 className="text-sm font-bold text-gray-800 mb-1">生徒向けの注意書き</h2>
                <p className="text-xs text-gray-500 mb-3">カレンダーの下に表示されます。</p>
                <textarea
                  value={notice}
                  onChange={(e) => { setNotice(e.target.value); setSaved(false) }}
                  rows={3}
                  placeholder="例：休業日は返信ができないことがあります。添削や質問回答が遅くなる場合があります。"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-green-500"
                />
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-5 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50"
                  style={{ backgroundColor: '#06C755' }}
                >
                  {saving ? '保存中…' : '保存'}
                </button>
                {saved && <span className="text-xs text-green-600">保存しました</span>}
              </div>

              {/* リッチメニュー用URL */}
              {liffUrl && (
                <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
                  <h2 className="text-xs font-bold text-gray-700 mb-1">リッチメニューに貼るURL</h2>
                  <p className="text-[11px] text-gray-500 mb-2">リッチメニュー編集でこのURLを「URL直接」アクションに設定すると、生徒が営業カレンダーを開けます。</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-[11px] text-gray-600 bg-white border border-gray-200 rounded px-2 py-1.5 truncate">{liffUrl}</code>
                    <button
                      onClick={() => { navigator.clipboard.writeText(liffUrl); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
                      className="text-xs px-3 py-1.5 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 whitespace-nowrap"
                    >
                      {copied ? 'コピー済' : 'コピー'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </>
  )
}
