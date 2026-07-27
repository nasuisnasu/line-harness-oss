'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'

interface Props {
  friendId: string
  /** Compact mode: smaller text, suitable for chat sidebar */
  compact?: boolean
}

interface EntryRouteInfo {
  id: string
  name: string
  refCode: string
}

interface Booking {
  id: string
  title: string
  startAt: string
  endAt: string
  status: string
  appEventId: string | null
  eventName: string | null
}

interface Payment {
  id: string
  amount: number
  note: string | null
  paidAt: string
  createdAt: string
}

interface LessonRecord {
  id: string
  type: 'contract' | 'lesson' | 'cancel'
  count: number
  recordDate: string
  note: string | null
  createdAt: string
}

interface LessonSummary {
  contracted: number
  conducted: number
  cancelled: number
  consumed: number
  remaining: number
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function formatDateOnly(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  })
}

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`
}

export default function FriendInfoPanel({ friendId, compact = false }: Props) {
  const [entryRoute, setEntryRoute] = useState<EntryRouteInfo | null>(null)
  const [joinedAt, setJoinedAt] = useState<string | null>(null)
  const [bookings, setBookings] = useState<Booking[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [paymentTotal, setPaymentTotal] = useState(0)
  const [family, setFamily] = useState<{
    role: string
    myName: string
    studentName: string
    parents: { id: string; displayName: string | null; parentName: string }[]
    children: { id: string; displayName: string | null; studentName: string }[]
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAddPayment, setShowAddPayment] = useState(false)
  const [paymentForm, setPaymentForm] = useState({
    amount: '',
    note: '',
    paidAt: new Date().toISOString().slice(0, 10),
  })
  const [saving, setSaving] = useState(false)
  const [lessons, setLessons] = useState<LessonRecord[]>([])
  const [lessonSummary, setLessonSummary] = useState<LessonSummary>({ contracted: 0, conducted: 0, cancelled: 0, consumed: 0, remaining: 0 })
  const [richMenu, setRichMenu] = useState<{ name: string | null; source: 'individual' | 'default' } | null>(null)
  // 追加フォームの種類: null=閉 / 'lesson' / 'cancel' / 'contract'
  const [lessonAddType, setLessonAddType] = useState<null | 'lesson' | 'cancel' | 'contract'>(null)
  const [lessonDate, setLessonDate] = useState(new Date().toISOString().slice(0, 10))
  const [lessonCount, setLessonCount] = useState('10')
  const [lessonNote, setLessonNote] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [friendRes, bookingsRes, paymentsRes, familyRes, lessonsRes, richMenuRes] = await Promise.allSettled([
        api.friends.get(friendId),
        api.friends.bookings(friendId),
        api.friends.payments.list(friendId),
        api.friends.family(friendId),
        api.friends.lessons.list(friendId),
        api.richMenus.getFriendCurrent(friendId),
      ])
      if (richMenuRes.status === 'fulfilled' && richMenuRes.value.success) {
        setRichMenu(richMenuRes.value.data)
      }
      if (friendRes.status === 'fulfilled' && friendRes.value.success) {
        const data = friendRes.value.data as { entryRoute?: EntryRouteInfo | null; createdAt: string }
        setEntryRoute(data.entryRoute ?? null)
        setJoinedAt(data.createdAt)
      }
      if (bookingsRes.status === 'fulfilled' && bookingsRes.value.success) {
        setBookings(bookingsRes.value.data)
      }
      if (paymentsRes.status === 'fulfilled' && paymentsRes.value.success) {
        setPayments(paymentsRes.value.data.payments)
        setPaymentTotal(paymentsRes.value.data.total)
      }
      if (familyRes.status === 'fulfilled' && familyRes.value.success) {
        setFamily(familyRes.value.data)
      }
      if (lessonsRes.status === 'fulfilled' && lessonsRes.value.success) {
        setLessons(lessonsRes.value.data.records)
        setLessonSummary(lessonsRes.value.data.summary)
      }
    } finally {
      setLoading(false)
    }
  }, [friendId])

  useEffect(() => { void load() }, [load])

  const handleAddPayment = async () => {
    const amount = Number(paymentForm.amount)
    if (!amount || !paymentForm.paidAt) return
    setSaving(true)
    try {
      const res = await api.friends.payments.add(friendId, {
        amount,
        note: paymentForm.note.trim() || undefined,
        paidAt: paymentForm.paidAt,
      })
      if (res.success) {
        setShowAddPayment(false)
        setPaymentForm({ amount: '', note: '', paidAt: new Date().toISOString().slice(0, 10) })
        await load()
      }
    } finally {
      setSaving(false)
    }
  }

  const handleDeletePayment = async (paymentId: string) => {
    if (!confirm('この入金記録を削除しますか？')) return
    const res = await api.friends.payments.delete(friendId, paymentId)
    if (res.success) await load()
  }

  const openLessonForm = (type: 'lesson' | 'cancel' | 'contract') => {
    setLessonAddType(type)
    setLessonDate(new Date().toISOString().slice(0, 10))
    setLessonCount('10')
    setLessonNote('')
  }

  const handleAddLesson = async () => {
    if (!lessonAddType) return
    if (lessonAddType === 'contract' && !(Number(lessonCount) > 0)) return
    setSaving(true)
    try {
      const res = await api.friends.lessons.add(friendId, {
        type: lessonAddType,
        count: lessonAddType === 'contract' ? Number(lessonCount) : undefined,
        recordDate: lessonDate,
        note: lessonNote.trim() || undefined,
      })
      if (res.success) {
        setLessonAddType(null)
        await load()
      }
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteLesson = async (recordId: string) => {
    if (!confirm('この授業記録を削除しますか？')) return
    const res = await api.friends.lessons.delete(friendId, recordId)
    if (res.success) await load()
  }

  const lessonTypeLabel = (t: LessonRecord['type']): string =>
    t === 'contract' ? '契約' : t === 'lesson' ? '実施' : 'キャンセル'

  if (loading) {
    return <div className="text-xs text-gray-400 py-2">読み込み中...</div>
  }

  const labelCls = compact ? 'text-[10px]' : 'text-xs'
  const valueCls = compact ? 'text-xs' : 'text-sm'

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      {/* 流入経路 + 登録日 */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className={`${labelCls} font-semibold text-gray-500 mb-0.5`}>流入経路</p>
          {entryRoute ? (
            <p className={`${valueCls} text-gray-900`}>{entryRoute.name}</p>
          ) : (
            <p className={`${valueCls} text-gray-400`}>不明</p>
          )}
        </div>
        <div>
          <p className={`${labelCls} font-semibold text-gray-500 mb-0.5`}>登録日</p>
          <p className={`${valueCls} text-gray-900`}>{formatDateOnly(joinedAt)}</p>
        </div>
      </div>

      {/* 現在表示中のリッチメニュー */}
      <div>
        <p className={`${labelCls} font-semibold text-gray-500 mb-0.5`}>現在のリッチメニュー</p>
        {richMenu?.name ? (
          <p className={`${valueCls} text-gray-900 flex items-center gap-2`}>
            <span>{richMenu.name}</span>
            <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-semibold ${richMenu.source === 'individual' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>
              {richMenu.source === 'individual' ? '個別リンク' : 'デフォルト'}
            </span>
          </p>
        ) : (
          <p className={`${valueCls} text-gray-400`}>{loading ? '確認中...' : '未設定'}</p>
        )}
      </div>

      {/* 受講生フォーム情報（氏名 + 属性バッジ） */}
      {family && (family.myName || family.role) && (
        <div>
          <p className={`${labelCls} font-semibold text-gray-500 mb-1`}>受講生情報</p>
          <div className="flex items-center gap-2 flex-wrap">
            {family.myName && (
              <span className="text-sm font-semibold text-gray-900">{family.myName}</span>
            )}
            {family.role === '生徒' && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-semibold">生徒</span>
            )}
            {family.role === '保護者' && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold">保護者</span>
            )}
          </div>
        </div>
      )}

      {/* 親子情報（保護者側にのみ表示） */}
      {family && family.children.length > 0 && (
        <div>
          <p className={`${labelCls} font-semibold text-gray-500 mb-1`}>関係</p>
          <div className="space-y-1">
            {family.children.map((c) => (
              <div key={c.id} className="text-xs bg-blue-50 border border-blue-200 rounded px-2 py-1.5">
                <span className="text-blue-700 font-semibold">{c.studentName || c.displayName || '名前未設定'}</span>
                <span className="text-blue-600 ml-1">の親</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 予約 */}
      <div>
        <p className={`${labelCls} font-semibold text-gray-500 mb-1`}>予約イベント</p>
        {bookings.length === 0 ? (
          <p className={`${valueCls} text-gray-400`}>なし</p>
        ) : (
          <ul className="space-y-1">
            {bookings.slice(0, compact ? 3 : 10).map((b) => (
              <li key={b.id} className={`${valueCls} text-gray-700 flex items-center gap-2`}>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  b.status === 'confirmed' ? 'bg-green-100 text-green-700' :
                  b.status === 'cancelled' ? 'bg-red-100 text-red-600' :
                  'bg-gray-100 text-gray-600'
                }`}>
                  {b.status === 'confirmed' ? '予約済' : b.status === 'cancelled' ? 'キャンセル' : b.status}
                </span>
                <span className="truncate">
                  {b.eventName ?? b.title} · {formatDate(b.startAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 授業記録 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className={`${labelCls} font-semibold text-gray-500`}>授業記録</p>
        </div>
        {/* 集計 */}
        <div className={`flex flex-wrap gap-x-3 gap-y-0.5 mb-1.5 ${valueCls}`}>
          <span className="text-gray-500">契約 <span className="font-semibold text-gray-900">{lessonSummary.contracted}</span>回</span>
          <span className="text-gray-500">実施 <span className="font-semibold text-gray-900">{lessonSummary.conducted}</span>回</span>
          <span className="text-gray-500">ｷｬﾝｾﾙ <span className="font-semibold text-gray-900">{lessonSummary.cancelled}</span>回</span>
          <span className="text-gray-500">残り <span className={`font-semibold ${lessonSummary.remaining <= 0 ? 'text-red-600' : 'text-green-700'}`}>{lessonSummary.remaining}</span>回</span>
        </div>
        {/* 記録ボタン */}
        <div className="flex gap-1.5 mb-2">
          <button type="button" onClick={() => openLessonForm('lesson')} className="text-xs px-2 py-1 bg-green-500 text-white rounded hover:bg-green-600">実施</button>
          <button type="button" onClick={() => openLessonForm('cancel')} className="text-xs px-2 py-1 bg-orange-400 text-white rounded hover:bg-orange-500">キャンセル</button>
          <button type="button" onClick={() => openLessonForm('contract')} className="text-xs px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300">契約追加</button>
        </div>

        {lessonAddType && (
          <div className="bg-gray-50 border border-gray-200 rounded p-2 mb-2 space-y-1.5">
            <p className="text-xs font-semibold text-gray-600">
              {lessonAddType === 'contract' ? '契約を追加' : lessonAddType === 'lesson' ? '授業を実施として記録' : 'キャンセルを記録（1回消化）'}
            </p>
            <div className="flex gap-1.5">
              {lessonAddType === 'contract' ? (
                <input
                  type="number"
                  placeholder="契約回数"
                  value={lessonCount}
                  onChange={(e) => setLessonCount(e.target.value)}
                  className="w-24 text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-green-500"
                />
              ) : (
                <input
                  type="date"
                  value={lessonDate}
                  onChange={(e) => setLessonDate(e.target.value)}
                  className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-green-500"
                />
              )}
            </div>
            <input
              type="text"
              placeholder="メモ（任意）"
              value={lessonNote}
              onChange={(e) => setLessonNote(e.target.value)}
              className="w-full text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-green-500"
            />
            <div className="flex gap-1.5 justify-end">
              <button onClick={() => setLessonAddType(null)} className="text-xs px-2 py-1 text-gray-600 hover:text-gray-800">キャンセル</button>
              <button onClick={handleAddLesson} disabled={saving} className="text-xs px-2 py-1 bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50">
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        )}

        {lessons.length === 0 ? (
          <p className={`${valueCls} text-gray-400`}>記録なし</p>
        ) : (
          <ul className="space-y-1">
            {lessons.map((r) => (
              <li key={r.id} className={`${valueCls} flex items-center justify-between gap-2 group`}>
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${r.type === 'contract' ? 'bg-gray-200 text-gray-700' : r.type === 'lesson' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
                    {lessonTypeLabel(r.type)}{r.type === 'contract' ? ` +${r.count}` : ''}
                  </span>
                  <span className="text-gray-500">{formatDateOnly(r.recordDate)}</span>
                  {r.note && <span className="text-gray-600 truncate">{r.note}</span>}
                </div>
                <button
                  onClick={() => handleDeleteLesson(r.id)}
                  className="opacity-0 group-hover:opacity-100 text-xs text-gray-400 hover:text-red-500 transition-opacity"
                  title="削除"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 入金 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className={`${labelCls} font-semibold text-gray-500`}>
            入金履歴 <span className="text-gray-700 ml-1">合計 {formatYen(paymentTotal)}</span>
          </p>
          <button
            type="button"
            onClick={() => setShowAddPayment(!showAddPayment)}
            className={`${compact ? 'text-[10px]' : 'text-xs'} font-medium text-green-600 hover:text-green-700`}
          >
            + 追加
          </button>
        </div>

        {showAddPayment && (
          <div className="bg-gray-50 border border-gray-200 rounded p-2 mb-2 space-y-1.5">
            <div className="flex gap-1.5">
              <input
                type="number"
                placeholder="金額"
                value={paymentForm.amount}
                onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })}
                className="flex-1 text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-green-500"
              />
              <input
                type="date"
                value={paymentForm.paidAt}
                onChange={(e) => setPaymentForm({ ...paymentForm, paidAt: e.target.value })}
                className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-green-500"
              />
            </div>
            <input
              type="text"
              placeholder="メモ（例: 入塾金、3ヶ月分など）"
              value={paymentForm.note}
              onChange={(e) => setPaymentForm({ ...paymentForm, note: e.target.value })}
              className="w-full text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-green-500"
            />
            <div className="flex gap-1.5 justify-end">
              <button
                onClick={() => setShowAddPayment(false)}
                className="text-xs px-2 py-1 text-gray-600 hover:text-gray-800"
              >
                キャンセル
              </button>
              <button
                onClick={handleAddPayment}
                disabled={!paymentForm.amount || saving}
                className="text-xs px-2 py-1 bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50"
              >
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        )}

        {payments.length === 0 ? (
          <p className={`${valueCls} text-gray-400`}>記録なし</p>
        ) : (
          <ul className="space-y-1">
            {payments.map((p) => (
              <li key={p.id} className={`${valueCls} flex items-center justify-between gap-2 group`}>
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="font-semibold text-gray-900">{formatYen(p.amount)}</span>
                  <span className="text-gray-500">{formatDateOnly(p.paidAt)}</span>
                  {p.note && <span className="text-gray-600 truncate">{p.note}</span>}
                </div>
                <button
                  onClick={() => handleDeletePayment(p.id)}
                  className="opacity-0 group-hover:opacity-100 text-xs text-gray-400 hover:text-red-500 transition-opacity"
                  title="削除"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
