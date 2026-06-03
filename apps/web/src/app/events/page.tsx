'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { api, type EventItem } from '@/lib/api'
import Header from '@/components/layout/header'
import { useAccount } from '@/lib/account-context'

const eventTypeLabels: Record<EventItem['eventType'], string> = {
  consultation: '個別相談（カレンダー予約）',
  seminar: 'セミナー',
}

const liffIdMap: Record<string, string> = {
  'd49a3a13-8169-4b25-a669-3c8a4f4f964d': '2009821004-brTkmVVK',
  '40adcb23-277b-4d9d-b6e2-92fde47d31fb': '2006855304-UfNPHFOn',
}

function buildEventUrl(liffId: string | null, slug: string): string {
  if (!liffId || !slug) return ''
  return `https://liff.line.me/${liffId}?page=event&slug=${encodeURIComponent(slug)}&liffId=${liffId}`
}

export default function EventsPage() {
  const [items, setItems] = useState<EventItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [eventType, setEventType] = useState<EventItem['eventType']>('consultation')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const { selectedAccount } = useAccount()
  const liffId = selectedAccount ? liffIdMap[selectedAccount.id] ?? null : null

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
      const res = await api.events.list(params)
      if (res.success) setItems(res.data)
      else setError(res.error)
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccount])

  useEffect(() => { load() }, [load])

  const handleCreate = async () => {
    if (!selectedAccount) { setFormError('LINEアカウントを選択してください'); return }
    if (!name.trim()) { setFormError('名前を入力してください'); return }
    if (!slug.trim() || !/^[a-z0-9-]+$/i.test(slug)) { setFormError('slugは英数字とハイフンのみ'); return }
    setSaving(true)
    setFormError('')
    try {
      const res = await api.events.create(
        { name: name.trim(), slug: slug.trim(), eventType, isActive: true },
        { lineAccountId: selectedAccount.id },
      )
      if (res.success) {
        setShowCreate(false)
        setName('')
        setSlug('')
        load()
      } else {
        setFormError(res.error)
      }
    } catch {
      setFormError('作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string, label: string) => {
    if (!confirm(`「${label}」を削除しますか？関連する予約も全て消えます`)) return
    await api.events.delete(id)
    load()
  }

  const handleToggle = async (item: EventItem) => {
    await api.events.update(item.id, { isActive: !item.isActive })
    load()
  }

  const handleCopyUrl = async (item: EventItem) => {
    const url = buildEventUrl(liffId, item.slug)
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopiedId(item.id)
      setTimeout(() => setCopiedId(prev => (prev === item.id ? null : prev)), 1500)
    } catch {
      // ignore
    }
  }

  return (
    <div>
      <Header
        title="イベント"
        action={
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + 新規イベント
          </button>
        }
      />

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>}

      {showCreate && (
        <div className="mb-6 bg-white rounded-lg border border-gray-200 p-6 max-w-xl">
          <h2 className="text-sm font-semibold text-gray-800 mb-4">新規イベント</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">種別</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEventType('consultation')}
                  className={`text-xs px-3 py-1.5 rounded border ${eventType === 'consultation' ? 'border-[#06C755] bg-[#06C755]/10 text-[#06C755]' : 'border-gray-300 text-gray-600 bg-white'}`}
                >
                  個別相談（カレンダー予約）
                </button>
                <button
                  type="button"
                  disabled
                  className="text-xs px-3 py-1.5 rounded border border-gray-200 text-gray-300 bg-white cursor-not-allowed"
                >
                  セミナー（後日）
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">名前 <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例: 個別相談（30分）"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">URLスラッグ <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="例: consultation-30"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 font-mono"
              />
              <p className="text-[11px] text-gray-400 mt-1">LIFF URL: https://liff.line.me/[liffId]?page=event&slug={slug || 'xxx'}</p>
            </div>
            {formError && <p className="text-xs text-red-600">{formError}</p>}
            <div className="flex gap-2">
              <button onClick={handleCreate} disabled={saving} className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
                {saving ? '作成中...' : '作成'}
              </button>
              <button onClick={() => { setShowCreate(false); setFormError('') }} className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg">キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-sm text-gray-400">読み込み中...</div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-sm text-gray-400">イベントがありません。「+ 新規イベント」から作成してください。</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {items.map((e) => (
            <div key={e.id} className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-bold text-gray-900 truncate">{e.name}</h3>
                  <p className="text-[11px] text-gray-500 font-mono mt-0.5">{e.slug}</p>
                </div>
                <button
                  onClick={() => handleToggle(e)}
                  className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${e.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}
                >
                  {e.isActive ? '公開中' : '停止中'}
                </button>
              </div>
              <p className="text-xs text-gray-500 mb-3">{eventTypeLabels[e.eventType]}</p>
              <div className="flex items-center gap-2 mb-3 bg-gray-50 border border-gray-200 rounded px-2 py-1.5">
                <span className="flex-1 min-w-0 text-[11px] text-gray-500 font-mono truncate">
                  {liffId ? buildEventUrl(liffId, e.slug) : 'LIFF ID未設定のアカウント'}
                </span>
                <button
                  type="button"
                  disabled={!liffId}
                  onClick={() => handleCopyUrl(e)}
                  className="flex-shrink-0 text-[11px] px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {copiedId === e.id ? 'コピー済' : 'URLコピー'}
                </button>
              </div>
              <div className="flex gap-2">
                <Link href={`/events/edit?id=${e.id}`} className="text-xs px-3 py-1.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-700">設定</Link>
                <Link href={`/events/bookings?id=${e.id}`} className="text-xs px-3 py-1.5 rounded bg-blue-50 hover:bg-blue-100 text-blue-700">予約一覧</Link>
                <button onClick={() => handleDelete(e.id, e.name)} className="text-xs px-3 py-1.5 rounded text-red-500 hover:bg-red-50 ml-auto">削除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
