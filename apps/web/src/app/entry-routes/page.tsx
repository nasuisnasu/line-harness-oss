'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import { useAccount } from '@/lib/account-context'

interface EntryRoute {
  id: string
  refCode: string
  name: string
  tagId: string | null
  scenarioId: string | null
  isActive: boolean
  createdAt: string
  count: number
}

interface Tag { id: string; name: string; color: string }

export default function EntryRoutesPage() {
  const [routes, setRoutes] = useState<EntryRoute[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ refCode: '', name: '', tagId: '' })
  const [saving, setSaving] = useState(false)
  const { selectedAccount } = useAccount()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
      const [routesRes, tagsRes] = await Promise.all([
        api.entryRoutes.list(params),
        api.tags.list(params),
      ])
      if (routesRes.success) setRoutes(routesRes.data)
      if (tagsRes.success) setTags(tagsRes.data)
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccount])

  useEffect(() => { load() }, [load])

  const handleCreate = async () => {
    if (!form.refCode || !form.name) return
    setSaving(true)
    try {
      const res = await api.entryRoutes.create({ refCode: form.refCode, name: form.name, tagId: form.tagId || null })
      if (res.success) {
        setShowCreate(false)
        setForm({ refCode: '', name: '', tagId: '' })
        load()
      }
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`「${name}」を削除しますか？`)) return
    await api.entryRoutes.delete(id)
    load()
  }

  const baseUrl = 'https://line-crm-worker.readash-crm.workers.dev'

  return (
    <div>
      <Header
        title="流入経路"
        action={
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + 新規追加
          </button>
        }
      />

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">{error}</div>}

      {showCreate && (
        <div className="mb-6 bg-white rounded-lg border border-gray-200 p-5 max-w-md">
          <h2 className="text-sm font-semibold mb-4">新規エントリールート</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">名前 *</label>
              <input type="text" className="w-full border border-gray-300 rounded px-3 py-2 text-sm" placeholder="例: セミナー003" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">refコード * (URLに使用)</label>
              <input type="text" className="w-full border border-gray-300 rounded px-3 py-2 text-sm font-mono" placeholder="例: seminar003" value={form.refCode} onChange={e => setForm({ ...form, refCode: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">自動付与タグ</label>
              <select className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white" value={form.tagId} onChange={e => setForm({ ...form, tagId: e.target.value })}>
                <option value="">なし</option>
                {tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={handleCreate} disabled={saving || !form.refCode || !form.name} className="px-4 py-2 text-sm font-medium text-white rounded disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
                {saving ? '作成中...' : '作成'}
              </button>
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded">キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">{[...Array(3)].map((_, i) => <div key={i} className="h-16 bg-white rounded-lg border border-gray-200 animate-pulse" />)}</div>
      ) : routes.length === 0 ? (
        <div className="text-center py-16 text-gray-400 text-sm">エントリールートがありません</div>
      ) : (
        <div className="space-y-3">
          {routes.map(r => {
            const tag = tags.find(t => t.id === r.tagId)
            return (
              <div key={r.id} className="bg-white rounded-lg border border-gray-200 p-4 flex items-start justify-between group">
                <div className="space-y-1 flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900 text-sm">{r.name}</span>
                    {tag && (
                      <span className="text-xs px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: tag.color }}>{tag.name}</span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 font-mono truncate">
                    {baseUrl}/liff/track?ref={r.refCode}
                  </div>
                </div>
                <div className="mx-4 text-right flex-shrink-0">
                  <span className="text-2xl font-bold text-gray-900">{r.count}</span>
                  <span className="text-xs text-gray-400 ml-1">人</span>
                </div>
                <button onClick={() => handleDelete(r.id, r.name)} className="ml-4 text-xs text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 flex-shrink-0">削除</button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
