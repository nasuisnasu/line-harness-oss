'use client'

import { Suspense, useState, useEffect, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { api, type EventBookingItem, type EventItem } from '@/lib/api'
import Header from '@/components/layout/header'

function fmt(iso: string): string {
  const d = new Date(iso)
  const jst = new Date(d.getTime() + 9 * 60 * 60_000)
  return `${jst.getUTCFullYear()}/${String(jst.getUTCMonth() + 1).padStart(2, '0')}/${String(jst.getUTCDate()).padStart(2, '0')} ${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`
}

function Inner() {
  const params = useSearchParams()
  const router = useRouter()
  const id = params.get('id') ?? ''
  const [event, setEvent] = useState<EventItem | null>(null)
  const [bookings, setBookings] = useState<EventBookingItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const [evRes, bkRes] = await Promise.all([api.events.get(id), api.events.bookings(id)])
      if (evRes.success) setEvent(evRes.data)
      if (bkRes.success) setBookings(bkRes.data)
      else setError(bkRes.error)
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  const handleCancel = async (bookingId: string) => {
    if (!confirm('この予約をキャンセルしますか？Google Calendarのイベントも削除されます')) return
    await api.events.cancelBooking(bookingId)
    load()
  }

  return (
    <div>
      <Header
        title={event ? `${event.name} - 予約一覧` : '予約一覧'}
        action={
          <button onClick={() => router.push('/events')} className="px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded">← イベント一覧</button>
        }
      />
      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="text-center py-8 text-sm text-gray-400">読み込み中...</div>
      ) : bookings.length === 0 ? (
        <div className="text-center py-12 text-sm text-gray-400">予約はまだありません</div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">日時</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">予約者</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">状態</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">予約日時</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {bookings.map((b) => (
                  <tr key={b.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-900">{fmt(b.startAt)}</td>
                    <td className="px-4 py-3 text-gray-700">{b.friendDisplayName ?? '（不明）'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${b.status === 'confirmed' ? 'bg-green-50 text-green-700' : b.status === 'cancelled' ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
                        {b.status === 'confirmed' ? '確定' : b.status === 'cancelled' ? 'キャンセル' : '完了'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{fmt(b.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      {b.status === 'confirmed' && (
                        <button onClick={() => handleCancel(b.id)} className="text-xs text-red-500 hover:text-red-700">キャンセル</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

export default function BookingsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-sm text-gray-400">読み込み中...</div>}>
      <Inner />
    </Suspense>
  )
}
